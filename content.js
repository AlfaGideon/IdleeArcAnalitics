/*
 * IdleArc Analyst — изолированный контент-скрипт (мост).
 *
 * 1) Внедряет перехватчик в MAIN world (встроенный или присланный по OTA).
 * 2) Принимает из него данные и пересылает в service worker.
 * 3) Доставляет «живые» OTA-правки в страницу БЕЗ перезагрузки расширения:
 *    регулярки, лимиты, переключатели подслушивания подхватываются на лету.
 */
(function () {
  'use strict';
  if (window.__IA_BRIDGE) return;   // уже внедрён (статически или программно)
  window.__IA_BRIDGE = true;
  const MARK = 'IA_PAGE_V1';
  const CFG_MARK = 'IA_OTA_CFG';

  let otaConfig = null;
  let hookGeneration = 0;
  let hookFingerprint = '';
  let fallbackTimer = null;
  let hookMode = 'packaged';

  /* ------------------------------------------------------------------ *
   * Конфигурация OTA
   * ------------------------------------------------------------------ */
  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : (r || null))); }
    catch (e) { res(null); }
  });

  async function fetchOtaConfig(attempts) {
    for (let i = 0; i < (attempts || 2); i++) {
      const r = await send({ type: 'ia:ota-effective' });
      if (r && r.ok && r.config) return r.config;
      await new Promise((res) => setTimeout(res, 150 * (i + 1)));
    }
    return null;
  }

  /** В MAIN world уходит только то, что нужно перехватчику (без лишних данных). */
  function pageConfig(cfg) {
    const s = (cfg && cfg.settings && cfg.settings.capture) || {};
    return {
      gen: hookGeneration,
      limitPerMinute: s.limitPerMinute,
      maxSampleBytes: s.maxSampleBytes,
      relevantPattern: s.relevantPattern,
      wsPattern: s.wsPattern,
      extraApiPaths: s.extraApiPaths || [],
      enableFetch: s.enableFetch !== false,
      enableXHR: s.enableXHR !== false,
      enableWS: s.enableWS !== false,
      features: (cfg && cfg.patch && cfg.patch.features) || {}
    };
  }

  function pushConfig() {
    const payload = { __ia: CFG_MARK, config: pageConfig(otaConfig), at: Date.now() };
    try { window.postMessage(payload, location.origin); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * Внедрение перехватчика
   * ------------------------------------------------------------------ */
  function injectPackaged() {
    hookMode = 'packaged';
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('inject.js');
      s.async = false;
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn('[IdleArc Analyst] не удалось внедрить перехватчик', e);
    }
  }

  function injectInlineHook(code) {
    hookMode = 'inline';
    clearTimeout(fallbackTimer);
    const s = document.createElement('script');
    s.textContent = code + '\n;try{window.postMessage({__ia:"IA_OTA_HOOK_OK",gen:' +
      hookGeneration + '},location.origin);}catch(e){}';
    (document.head || document.documentElement).appendChild(s);
    // CSP страницы может молча запретить inline-скрипт — проверяем ack.
    fallbackTimer = setTimeout(() => {
      if (hookMode === 'inline' && !window.__IA_OTA_HOOK_ACK) {
        console.warn('[IdleArc Analyst] inline OTA-hook заблокирован CSP, используем встроенный');
        s.remove();
        injectPackaged();
        pushConfig();
      }
    }, 500);
  }

  async function inject() {
    const cfg = otaConfig || {};
    const code = cfg.patch && cfg.patch.hookCode;
    if (!code || typeof code !== 'string') { injectPackaged(); pushConfig(); return; }

    hookFingerprint = code.length + ':' + code.slice(0, 120);
    const gen = ++hookGeneration;

    // Способ 1: выполнить в MAIN world силами chrome.scripting (обходит CSP страницы).
    let r = await send({ type: 'ia:ota-run-hook', code: code, gen: gen });
    if (r && r.ok) {
      hookMode = 'scripting';
      window.__IA_OTA_HOOK_ACK = gen;
      pushConfig();
      return;
    }
    // Способ 2: inline <script> (с проверкой ack и откатом).
    window.__IA_OTA_HOOK_ACK = 0;
    injectInlineHook(code);
    pushConfig();
  }

  /* ------------------------------------------------------------------ *
   * Приём данных из страницы
   * ------------------------------------------------------------------ */
  let forwarded = 0;
  let windowStart = Date.now();

  function throttled() {
    const now = Date.now();
    if (now - windowStart > 60000) { windowStart = now; forwarded = 0; }
    const limit = (otaConfig && otaConfig.settings && otaConfig.settings.capture &&
      otaConfig.settings.capture.limitPerMinute) || 400;
    return ++forwarded > limit;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d) return;

    if (d.__ia === 'IA_OTA_HOOK_OK') {
      window.__IA_OTA_HOOK_ACK = d.gen;
      clearTimeout(fallbackTimer);
      pushConfig();
      return;
    }
    if (d.__ia === CFG_MARK + '_REQUEST') { pushConfig(); return; }
    if (d.__ia !== MARK) return;

    if (d.kind === 'ready') {
      chrome.runtime.sendMessage({ type: 'ia:page-ready', href: d.href }).catch(() => {});
      pushConfig();          // перехватчик мог подняться позже первой рассылки
      return;
    }
    if (d.kind === 'extract-response') {
      document.dispatchEvent(new CustomEvent('ia:extract-result', { detail: d.payload }));
      return;
    }
    if (throttled()) return;

    chrome.runtime.sendMessage({
      type: 'ia:capture',
      payload: {
        kind: d.kind,
        path: d.path,
        url: d.url,
        method: d.method,
        status: d.status,
        event: d.event,
        at: d.at,
        body: d.body
      }
    }).catch(() => {});
  });

  /* ------------------------------------------------------------------ *
   * Живая смена правок без перезагрузки расширения
   * ------------------------------------------------------------------ */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'ia:ota-changed' || !msg.config) return;
    otaConfig = msg.config;
    pushConfig();
    const code = otaConfig.patch && otaConfig.patch.hookCode;
    const fp = code ? code.length + ':' + code.slice(0, 120) : '';
    if (fp !== hookFingerprint) {
      // Менять сам перехватчик «на живую» нельзя (он уже обернул fetch/XHR).
      // Сообщаем об этом оверлею — в центре обновлений есть кнопка перезагрузки вкладок.
      console.info('[IdleArc Analyst] OTA: код перехватчика изменён, нужна перезагрузка вкладки игры');
      document.dispatchEvent(new CustomEvent('ia:ota-need-reload'));
      hookFingerprint = fp;
    }
  });

  /* -------- мостик для оверлея: запрос локального снимка -------- */
  document.addEventListener('ia:request-snapshot', () => {
    window.postMessage({ __ia: MARK, kind: 'request-snapshot' }, location.origin);
  });

  /* ------------------------------------------------------------------ *
   * Запуск
   * ------------------------------------------------------------------ */
  (async function boot() {
    // Не задерживаем внедрение перехватчика: если service worker ещё просыпается,
    // стартуем с встроенными настройками максимум через 400 мс, а конфиг
    // подхватим позже сообщением (все параметры меняются на лету).
    const pending = fetchOtaConfig(2);
    pending.then((c) => {
      if (!c) return;
      if (!otaConfig) { otaConfig = c; pushConfig(); }
      // Конфиг с новым кодом перехватчика пришёл слишком поздно — на живую
      // его подменить нельзя, просим перезагрузить вкладку.
      if (c.patch && c.patch.hookCode && hookMode === 'packaged') {
        document.dispatchEvent(new CustomEvent('ia:ota-need-reload'));
        console.info('[IdleArc Analyst] OTA: нужен reload для hookCode');
      }
    }).catch(() => {});
    otaConfig = await Promise.race([
      pending,
      new Promise((res) => setTimeout(() => res(null), 400))
    ]);
    let started = false;
    function start() {
      if (started) return;          // DOMContentLoaded + немедленный старт
      started = true;
      inject();
      setTimeout(pushConfig, 600);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      start(); // не ждём: игра стартует сразу
    } else {
      start();
    }
  })();
})();
