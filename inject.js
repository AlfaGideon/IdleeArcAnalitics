/*
 * IdleArc Analyst — перехватчик сетевых данных.
 *
 * Работает в MAIN world страницы (как её собственный скрипт), поэтому видит
 * fetch/XHR/WebSocket игры. Ничего не изменяет: только наблюдает и передаёт
 * извлечённые данные в изолированный контент-скрипт через window.postMessage.
 *
 * Все настройки (регулярки, лимиты, переключатели) приходят по OTA и могут
 * меняться на лету сообщением IA_OTA_CFG — перезагрузка страницы не нужна.
 */
(function () {
  'use strict';
  if (window.__IA_HOOKED) return;
  window.__IA_HOOKED = true;

  const MARK = 'IA_PAGE_V1';
  const CFG_MARK = 'IA_OTA_CFG';
  const API_HOST = 'idlearc.com';

  const DEFAULTS = {
    gen: 0,
    limitPerMinute: 400,
    maxSampleBytes: 250 * 1024,
    relevantPattern: 'combatStats|bonusStats|attackDamage|maxHealth|stateUpdates|player_dps|combat_live|dps|kills_per_min|monsterLevel|skillPoints',
    wsPattern: 'combat_live|player_dps|stateUpdates|dps|monster|stats',
    extraApiPaths: [],
    enableFetch: true,
    enableXHR: true,
    enableWS: true,
    features: {}
  };

  let CFG = Object.assign({}, DEFAULTS);
  let relevantRe = compile(CFG.relevantPattern);
  let wsRe = compile(CFG.wsPattern);

  function compile(src) {
    try { return new RegExp(src, 'i'); } catch (e) { return /combatStats|dps|stats/i; }
  }

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    for (const k of Object.keys(DEFAULTS)) {
      if (cfg[k] !== undefined && cfg[k] !== null) CFG[k] = cfg[k];
    }
    if (Array.isArray(CFG.extraApiPaths)) {
      CFG.extraApiPaths = CFG.extraApiPaths.filter((p) => typeof p === 'string').slice(0, 100);
    } else CFG.extraApiPaths = [];
    if (!CFG.features || typeof CFG.features !== 'object') CFG.features = {};
    relevantRe = compile(CFG.relevantPattern);
    wsRe = compile(CFG.wsPattern);
  }

  const sent = new Set();

  function post(msg) {
    try {
      msg.__ia = MARK;
      window.postMessage(msg, location.origin);
    } catch (e) { /* ignore */ }
  }

  /* -------- приём «живых» OTA-правок -------- */
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__ia !== CFG_MARK || !d.config) return;
    applyConfig(d.config);
  });
  try { window.postMessage({ __ia: CFG_MARK + '_REQUEST' }, location.origin); } catch (e) { /* ignore */ }

  /** Рекурсивно урезает объект: длинные массивы → первые 3 элемента. */
  function shrink(value, depth) {
    depth = depth || 0;
    if (depth > 6) return null;
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length > 400 ? value.slice(0, 400) : value;
    if (Array.isArray(value)) return value.slice(0, 3).map((v) => shrink(v, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      let i = 0;
      for (const k of Object.keys(value)) {
        if (i++ > 120) break;
        out[k] = shrink(value[k], depth + 1);
      }
      return out;
    }
    return null;
  }

  function isApi(url) {
    try {
      const u = new URL(url, location.href);
      return u.hostname.endsWith(API_HOST) && u.pathname.startsWith('/api');
    } catch (e) { return false; }
  }

  function pathOf(url) {
    try { return new URL(url, location.href).pathname.replace(/^\/api/, '') || '/'; }
    catch (e) { return String(url); }
  }

  /** Интересен ли ответ: регулярка из OTA либо явно указанный путь. */
  function looksRelevant(text, url) {
    if (CFG.features.pause_capture) return false;
    if (CFG.features.sample_all) return true;
    const path = pathOf(url);
    if (CFG.extraApiPaths.some((p) => p && (path.includes(p) || String(url).includes(p)))) return true;
    return !!(text && text.length >= 20 && relevantRe.test(text));
  }

  function emit(kind, url, method, status, text, extra) {
    if (!text || !looksRelevant(text, url)) return;
    const key = String(url) + '|' + text.length + '|' + text.slice(0, 120);
    if (sent.has(key)) return;
    if (sent.size > 400) sent.clear();
    sent.add(key);

    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return; }
    const sample = shrink(parsed);
    let serialized;
    try { serialized = JSON.stringify(sample); } catch (e) { return; }
    if (!serialized || serialized.length > CFG.maxSampleBytes) return;

    post({
      kind: kind || 'response',
      url: String(url),
      path: pathOf(url),
      method: method || 'GET',
      status: status || 0,
      at: Date.now(),
      body: sample,
      extra: extra || null
    });
  }

  /* ---------------------------- fetch ---------------------------- */
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const p = nativeFetch.apply(this, arguments);
      try {
        if (CFG.enableFetch && isApi(url)) {
          p.then((res) => {
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (!ct.includes('json')) return;
            res.clone().text().then((t) => emit('response', url, method, res.status, t)).catch(() => {});
          }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  /* ----------------------------- XHR ----------------------------- */
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__ia_url = url;
      this.__ia_method = method;
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        this.addEventListener('load', () => {
          if (!CFG.enableXHR || !isApi(this.__ia_url)) return;
          const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
          if (!ct.includes('json')) return;
          let text = '';
          try { text = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText; }
          catch (e) { return; }
          emit('response', this.__ia_url, this.__ia_method, this.status, text);
        });
        if (body && isApi(this.__ia_url)) {
          try {
            const b = typeof body === 'string' ? body : '';
            if (b.length < 2000) post({ kind: 'request', path: pathOf(this.__ia_url), method: this.__ia_method, body: b, at: Date.now() });
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      return send.apply(this, arguments);
    };
  }

  /* -------------------------- WebSocket -------------------------- */
  const NativeWS = window.WebSocket;
  if (typeof NativeWS === 'function') {
    function PatchedWS(url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      try {
        ws.addEventListener('message', (ev) => {
          if (!CFG.enableWS) return;
          const data = typeof ev.data === 'string' ? ev.data : '';
          if (!data || data.length > 200000) return;
          if (!CFG.features.sample_all && !wsRe.test(data)) return;
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) { parsed = null; }
          post({
            kind: 'ws',
            url: String(url),
            at: Date.now(),
            event: (parsed && (parsed.event || parsed.type)) || null,
            body: parsed ? shrink(parsed) : data.slice(0, 2000)
          });
        });
      } catch (e) { /* ignore */ }
      return ws;
    }
    PatchedWS.prototype = NativeWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { PatchedWS[k] = NativeWS[k]; });
    window.WebSocket = PatchedWS;
  }

  post({ kind: 'ready', at: Date.now(), href: location.href });
})();
