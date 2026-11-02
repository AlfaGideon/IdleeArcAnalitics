/*
 * IdleArc Analyst — клиент OTA в service worker.
 *
 * Подключается через importScripts('ota-updater.js') в background.js.
 * Отвечает за: состояние канала, периодическую проверку, проверку хэша/подписи,
 * применение и откат правок, локальные правки из редактора, публикацию в GitHub.
 */
(function (global) {
  'use strict';

  const Core = global.IAOTACore;
  const Conf = global.IAOTAConfig;
  const STORAGE_KEY = 'ota';
  const APP_VERSION = (global.chrome && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest().version : '1.1.0';

  let state = null;
  let saveTimer = null;
  let inFlightCheck = null;
  let initialized = false;
  let broadcastFn = null;
  let changeHook = null;   // background.js подписывается на смену конфигурации

  /* ------------------------------------------------------------------ *
   * Состояние
   * ------------------------------------------------------------------ */
  function emptyState() {
    return {
      prefs: Object.assign({}, Conf.DEFAULT_PREFS),
      publisher: Object.assign({}, Conf.DEFAULT_PUBLISHER),
      lastCheckAt: 0,
      lastOkAt: 0,
      lastError: '',
      needsNewBuild: false,
      applied: null,      // { payload, appliedAt, source, signature }
      available: null,    // { payload, fetchedAt, integrity }
      localPatch: null,   // локальные правки из редактора
      history: [],        // предыдущие applied (для отката)
      log: []
    };
  }

  async function load() {
    if (state) return state;
    let stored = null;
    try {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      stored = got && got[STORAGE_KEY];
    } catch (e) { /* хранилище недоступно — работаем в памяти */ }
    state = Object.assign(emptyState(), Core.isObj(stored) ? stored : {});
    state.prefs = Object.assign({}, Conf.DEFAULT_PREFS, state.prefs || {});
    state.publisher = Object.assign({}, Conf.DEFAULT_PUBLISHER, state.publisher || {});
    if (!Array.isArray(state.history)) state.history = [];
    if (!Array.isArray(state.log)) state.log = [];
    return state;
  }

  /* Один общий promise на всё окно debounce:
   * иначе «перезапуск» таймера оставлял бы первый await save() висящим навсегда. */
  let savePromise = null;
  function save() {
    if (!state) return Promise.resolve();
    if (savePromise) return savePromise;
    savePromise = new Promise((resolve) => {
      saveTimer = setTimeout(async () => {
        saveTimer = null;
        try { await chrome.storage.local.set({ [STORAGE_KEY]: state }); } catch (e) { /* ignore */ }
        savePromise = null;
        resolve();
      }, 100);
    });
    return savePromise;
  }

  function log(level, text) {
    if (!state) return;
    state.log.unshift({ t: Date.now(), level: level, text: String(text).slice(0, 400) });
    if (state.log.length > Conf.LOG_LIMIT) state.log.length = Conf.LOG_LIMIT;
    save();
  }

  function pubKey() {
    return (state && state.prefs && state.prefs.pubKey) || Conf.PINNED_PUB_KEY || '';
  }

  /* ------------------------------------------------------------------ *
   * Рассылка изменений
   * ------------------------------------------------------------------ */
  function gameUrl(url) {
    return /^https:\/\/(staging\.)?idlearc\.com\//.test(url || '');
  }

  function notify(message) {
    try { chrome.runtime.sendMessage(message).catch(() => {}); } catch (e) { /* ignore */ }
    try {
      chrome.tabs.query({}, (tabs) => {
        (tabs || []).forEach((t) => {
          if (t.id && gameUrl(t.url)) {
            try { chrome.tabs.sendMessage(t.id, message, () => void chrome.runtime.lastError); }
            catch (e) { /* ignore */ }
          }
        });
      });
    } catch (e) { /* tabs API может быть недоступен */ }
  }

  function updateBadge() {
    try {
      chrome.action.setBadgeBackgroundColor({ color: '#7c5cff' });
      chrome.action.setBadgeText({ text: state && state.available ? '↑' : '' });
    } catch (e) { /* ignore */ }
  }

  function onChanged(reason) {
    updateBadge();
    const eff = Core.effective(state, APP_VERSION);
    if (global.IAS && typeof global.IAS.applyRemoteConfig === 'function') {
      try { global.IAS.applyRemoteConfig(eff.patch); } catch (e) { log('warn', 'IAS.applyRemoteConfig: ' + e.message); }
    }
    if (changeHook) {
      try { changeHook(eff); } catch (e) { log('warn', 'changeHook: ' + e.message); }
    }
    notify({ type: 'ia:ota-changed', config: eff, reason: reason });
    return eff;
  }

  /* ------------------------------------------------------------------ *
   * Загрузка канала
   * ------------------------------------------------------------------ */
  async function fetchJson(url, force) {
    const u = new URL(url);
    if (!/^https:$/.test(u.protocol)) throw new Error('канал должен быть по HTTPS');
    let target = url;
    if (force) target += (url.includes('?') ? '&' : '?') + '_=' + Date.now();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), Conf.FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch(target, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: ctrl ? ctrl.signal : undefined
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text.length > Core.LIMITS.maxPayloadChars * 2) throw new Error('ответ слишком большой');
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('канал не является JSON'); }
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function validateRemote(raw) {
    const integrity = await Core.verifyPayload(raw, pubKey());
    const checked = await Core.validate(raw, {
      extensionVersion: APP_VERSION,
      fromRemote: true,
      requireSignature: state.prefs.requireSignature,
      allowUnsignedCode: state.prefs.allowUnsignedCode,
      integrity: integrity
    });
    return checked;
  }

  /**
   * Проверить канал. force=true игнорирует интервал (кнопка «Проверить»).
   * Возвращает { ok, updated, version, error, warnings, status }.
   */
  async function check(force, reason) {
    // Параллельный вызов (старт браузера + кнопка «Проверить») просто ждёт
    // текущую проверку и получает её результат, а не ошибку «уже идёт».
    if (inFlightCheck) return inFlightCheck;
    inFlightCheck = doCheck(force, reason);
    try { return await inFlightCheck; }
    finally { inFlightCheck = null; }
  }

  async function doCheck(force, reason) {
    await load();
    state.lastCheckAt = Date.now();
    state.lastError = '';
    state.needsNewBuild = false;
    await save();
    try {
      const urls = [state.prefs.channelUrl, state.prefs.backupUrl].filter((u) => typeof u === 'string' && /^https:\/\//.test(u));
      if (!urls.length) throw new Error('не задан URL канала');
      let lastErr = '';
      let needBuild = false;
      let checked = null;
      for (const url of urls) {
        try {
          const raw = await fetchJson(url, !!force);
          checked = await validateRemote(raw);
          if (checked.ok) break;
          lastErr = checked.error;
          needBuild = needBuild || !!checked.needsNewBuild;
          log('warn', (url === state.prefs.channelUrl ? 'канал' : 'зеркало') + ': ' + lastErr);
          checked = null;
        } catch (e) {
          lastErr = String(e && e.message || e);
          log('warn', (url === state.prefs.channelUrl ? 'канал' : 'зеркало') + ': ' + lastErr);
        }
      }
      if (!checked || !checked.ok) {
        const err = (checked && checked.error) || lastErr || 'канал недоступен';
        state.lastError = err;
        state.needsNewBuild = needBuild;
        log('error', 'Проверка не удалась: ' + err);
        await save();
        return { ok: false, error: err, needsNewBuild: state.needsNewBuild, status: await status() };
      }
      (checked.warnings || []).forEach((w) => log('warn', w));
      state.lastOkAt = Date.now();
      const incoming = checked.payload;
      const current = state.applied && state.applied.payload ? state.applied.payload.version : null;
      const newer = !current || Core.isNewer(incoming.version, current);
      state.available = newer ? {
        payload: incoming,
        fetchedAt: Date.now(),
        integrity: checked.integrity,
        warnings: checked.warnings || []
      } : null;
      log('info', newer
        ? 'Найдено обновление v' + incoming.version
        : 'Канал актуален (v' + incoming.version + ')');
      let applied = false;
      if (newer && state.prefs.applyAutomatically) {
        await applyAvailable();
        applied = true;
      }
      await save();
      updateBadge();
      return {
        ok: true, updated: newer, applied: applied, version: incoming.version,
        warnings: checked.warnings || [], status: await status()
      };
    } catch (e) {
      const err = String(e && e.message || e);
      state.lastError = err;
      log('error', 'Проверка не удалась: ' + err);
      await save();
      return { ok: false, error: err, status: await status() };
    }
  }

  async function maybeCheck(reason) {
    await load();
    if (!state.prefs.autoCheck) return;
    const interval = Math.max(5, Number(state.prefs.checkIntervalMin) || 60) * 60 * 1000;
    if (Date.now() - (state.lastCheckAt || 0) < interval) return;
    check(false, reason || 'auto').catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   * Применение / откат / локальные правки
   * ------------------------------------------------------------------ */
  async function applyPayload(payload, source, integrity) {
    await load();
    if (state.applied && state.applied.payload) {
      state.history.unshift(Core.clone(state.applied));
      if (state.history.length > Conf.HISTORY_LIMIT) state.history.length = Conf.HISTORY_LIMIT;
    }
    state.applied = {
      payload: Core.clone(payload),
      appliedAt: Date.now(),
      source: source,
      signature: integrity ? {
        hashOk: !!integrity.hashOk,
        signature: integrity.signature,
        detail: integrity.detail || ''
      } : { hashOk: true, signature: 'absent', detail: 'локальная правка' }
    };
    state.available = null;
    state.lastError = '';
    log('ok', 'Применено v' + payload.version + ' (' + source + ')');
    await save();
    onChanged('apply');
    return Core.effective(state, APP_VERSION);
  }

  async function applyAvailable() {
    await load();
    if (!state.available) return { ok: false, error: 'обновлений нет', status: await status() };
    const a = state.available;
    await applyPayload(a.payload, 'channel', a.integrity);
    return { ok: true, status: await status() };
  }

  /** Ручной импорт JSON (файл/вставка) — доверенный источник, подпись не требуется. */
  async function importManual(text) {
    await load();
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: 'некорректный JSON: ' + e.message, status: await status() }; }
    const checked = await Core.validate(raw, {
      extensionVersion: APP_VERSION,
      fromRemote: false,
      integrity: raw.integrity ? await Core.verifyPayload(raw, pubKey()) : null
    });
    if (!checked.ok) return { ok: false, error: checked.error, status: await status() };
    await applyPayload(checked.payload, 'manual', checked.integrity);
    return { ok: true, status: await status() };
  }

  async function rollback() {
    await load();
    if (!state.history.length) return { ok: false, error: 'откатывать нечего', status: await status() };
    const prev = state.history.shift();
    state.applied = prev;
    state.available = null;
    log('warn', 'Откат на v' + (prev.payload && prev.payload.version));
    await save();
    onChanged('rollback');
    return { ok: true, status: await status() };
  }

  async function factoryReset() {
    await load();
    if (state.applied) {
      state.history.unshift(Core.clone(state.applied));
      if (state.history.length > Conf.HISTORY_LIMIT) state.history.length = Conf.HISTORY_LIMIT;
    }
    state.applied = null;
    state.available = null;
    state.localPatch = null;
    state.lastError = '';
    log('warn', 'Сброс к заводским настройкам');
    await save();
    onChanged('reset');
    return { ok: true, status: await status() };
  }

  async function setLocalPatch(raw) {
    await load();
    if (raw == null) {
      state.localPatch = null;
      log('info', 'Локальные правки сброшены');
    } else {
      const patch = Core.pickLocalPatch(raw);
      if (!patch) return { ok: false, error: 'правка должна быть JSON-объектом', status: await status() };
      state.localPatch = patch;
      (patch.warnings || []).forEach((w) => log('warn', 'Локальная правка: ' + w));
      log('ok', 'Локальная правка применена');
    }
    await save();
    onChanged('local');
    return { ok: true, status: await status() };
  }

  /* ------------------------------------------------------------------ *
   * Настройки
   * ------------------------------------------------------------------ */
  async function setPrefs(partial) {
    await load();
    const allowed = ['channelUrl', 'backupUrl', 'autoCheck', 'checkIntervalMin',
      'requireSignature', 'allowUnsignedCode', 'pubKey', 'applyAutomatically'];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(partial || {}, k)) {
        let v = partial[k];
        if (k === 'channelUrl' || k === 'backupUrl' || k === 'pubKey') v = String(v || '').trim();
        if ((k === 'channelUrl' || k === 'backupUrl') && v && !/^https:\/\//.test(v)) {
          return { ok: false, error: 'URL канала должен начинаться с https://', status: await status() };
        }
        if (k === 'checkIntervalMin') v = Math.min(10080, Math.max(5, Number(v) || 60));
        state.prefs[k] = v;
      }
    }
    log('info', 'Настройки канала сохранены');
    await save();
    schedule();
    return { ok: true, status: await status() };
  }

  async function setPublisher(partial) {
    await load();
    const allowed = ['owner', 'repo', 'branch', 'path', 'token', 'privateKeyPem'];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(partial || {}, k)) {
        state.publisher[k] = typeof partial[k] === 'string' ? partial[k] : '';
      }
    }
    await save();
    return { ok: true, status: await status() };
  }

  /* ------------------------------------------------------------------ *
   * Публикация документа канала
   * ------------------------------------------------------------------ */

  /** Собирает готовый update.json: канонический хэш + (опционально) подпись. */
  async function buildChannel(raw) {
    await load();
    const doc = Core.isObj(raw) ? Core.clone(raw) : {};
    doc.schema = 1;
    doc.app = 'IdleArc Analyst';
    if (!Core.parseVersion(doc.version)) doc.version = bumpVersion(currentVersion());
    doc.channel = doc.channel || 'stable';
    doc.publishedAt = new Date().toISOString();
    doc.minExtension = doc.minExtension || '1.1.0';
    const key = state.publisher.privateKeyPem || '';
    const signed = await Core.signPayload(doc, key || null);
    const checked = await Core.validate(signed, {
      extensionVersion: APP_VERSION, fromRemote: false,
      integrity: await Core.verifyPayload(signed, pubKey())
    });
    if (!checked.ok) return { ok: false, error: checked.error };
    return { ok: true, document: signed, signed: !!signed.integrity.signature };
  }

  function currentVersion() {
    return (state && state.applied && state.applied.payload && state.applied.payload.version) || APP_VERSION;
  }

  function bumpVersion(v) {
    const p = Core.parseVersion(v) || { nums: [1, 1, 0] };
    return p.nums[0] + '.' + p.nums[1] + '.' + (p.nums[2] + 1);
  }

  function base64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    return Core.bytesToBase64(bytes);
  }

  async function githubApi(path, options) {
    const p = state.publisher;
    if (!p.token) throw new Error('не задан токен GitHub');
    const url = 'https://api.github.com/repos/' + encodeURIComponent(p.owner) + '/' +
      encodeURIComponent(p.repo) + '/contents/' +
      String(p.path || 'ota/update.json').split('/').map(encodeURIComponent).join('/') +
      (path || '');
    const res = await fetch(url, Object.assign({
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + p.token,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      cache: 'no-store'
    }, options || {}));
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    if (!res.ok) {
      const msg = body && body.message ? body.message : ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return body;
  }

  async function testPublisher() {
    await load();
    try {
      await githubApi('?ref=' + encodeURIComponent(state.publisher.branch || 'main'), { method: 'GET' });
      log('ok', 'GitHub: соединение работает');
      return { ok: true, status: await status() };
    } catch (e) {
      // 404 означает, что файла ещё нет — это нормально для первой публикации,
      // но отличаем от ошибки авторизации
      const msg = String(e.message || e);
      if (/Not Found|404/.test(msg)) {
        log('ok', 'GitHub: доступ есть, файл ещё не создан');
        return { ok: true, status: await status() };
      }
      log('error', 'GitHub: ' + msg);
      return { ok: false, error: msg, status: await status() };
    }
  }

  async function publish(raw) {
    await load();
    let built;
    try { built = await buildChannel(raw); }
    catch (e) { return { ok: false, error: String(e && e.message || e), status: await status() }; }
    if (!built.ok) return { ok: false, error: built.error, status: await status() };
    try {
      const p = state.publisher;
      let sha = null;
      try {
        const existing = await githubApi('?ref=' + encodeURIComponent(p.branch || 'main'), { method: 'GET' });
        if (existing && existing.sha) sha = existing.sha;
      } catch (e) {
        if (!/Not Found|404/.test(String(e.message || e))) throw e;
      }
      const content = base64Utf8(JSON.stringify(built.document, null, 2) + '\n');
      const body = {
        message: 'OTA: v' + built.document.version + ' (IdleArc Analyst)',
        content: content,
        branch: p.branch || 'main'
      };
      if (sha) body.sha = sha;
      await githubApi('', { method: 'PUT', body: JSON.stringify(body) });
      log('ok', 'Опубликовано v' + built.document.version + (built.signed ? ' (подписано)' : ' (без подписи)'));
      // У автора правки должны примениться сразу: raw.githubusercontent.com
      // кеширует ответ ~5 минут, поэтому не ждём следующей проверки канала.
      const localCopy = Core.stripIntegrity(built.document);
      const checked = await Core.validate(localCopy, { extensionVersion: APP_VERSION, fromRemote: false });
      if (checked.ok) {
        await applyPayload(checked.payload, 'publish', await Core.verifyPayload(built.document, pubKey()));
      }
      // и всё равно перепроверяем канал чуть позже (для контроля результата)
      setTimeout(() => check(true, 'publish'), 1500);
      return { ok: true, version: built.document.version, signed: built.signed, status: await status() };
    } catch (e) {
      const msg = String(e && e.message || e);
      log('error', 'Публикация: ' + msg);
      return { ok: false, error: msg, status: await status() };
    }
  }

  /* ------------------------------------------------------------------ *
   * Планировщик
   * ------------------------------------------------------------------ */
  function schedule() {
    if (!chrome.alarms || !chrome.alarms.create) return;
    try {
      const minutes = Math.max(5, Number(state && state.prefs && state.prefs.checkIntervalMin) || 60);
      chrome.alarms.create('ia-ota-check', { periodInMinutes: minutes, delayInMinutes: 1 });
    } catch (e) { /* в некоторых мобильных браузерах alarms недоступен */ }
  }

  /* В MV3 слушатели событий должны регистрироваться СИНХРОННО при старте
   * service worker: если спрятать их за await, будильник может не разбудить SW. */
  if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === 'ia-ota-check') maybeCheck('alarm');
    });
  }

  async function init(broadcast) {
    if (initialized) return;                    // SW поднимается много раз
    initialized = true;
    broadcastFn = broadcast || null;
    await load();
    schedule();
    onChanged('init');
    maybeCheck('startup');
  }

  /* ------------------------------------------------------------------ *
   * Публичное состояние для UI
   * ------------------------------------------------------------------ */
  async function status() {
    await load();
    const eff = Core.effective(state, APP_VERSION);
    const p = state.publisher || {};
    return {
      installedVersion: APP_VERSION,
      effective: eff,
      prefs: Object.assign({}, state.prefs),
      publisher: {
        owner: p.owner || '', repo: p.repo || '', branch: p.branch || '', path: p.path || '',
        hasToken: !!p.token, hasPrivateKey: !!p.privateKeyPem
      },
      applied: state.applied ? {
        version: state.applied.payload.version,
        appliedAt: state.applied.appliedAt,
        source: state.applied.source,
        signature: state.applied.signature,
        changelog: state.applied.payload.changelog || [],
        notes: state.applied.payload.notes || ''
      } : null,
      appliedDocument: state.applied ? Core.clone(state.applied.payload) : null,
      availableDocument: state.available ? Core.clone(state.available.payload) : null,
      available: state.available ? {
        version: state.available.payload.version,
        fetchedAt: state.available.fetchedAt,
        changelog: state.available.payload.changelog || [],
        notes: state.available.payload.notes || '',
        warnings: state.available.warnings || []
      } : null,
      localPatch: state.localPatch || null,
      localPatchRaw: state.localPatch ? {
        settings: state.localPatch.settings || {},
        patch: state.localPatch.patch || {},
        announcement: state.localPatch.announcement || null,
        note: state.localPatch.note || '',
        version: state.localPatch.version || ''
      } : null,
      history: state.history.map((h) => ({
        version: h.payload && h.payload.version,
        appliedAt: h.appliedAt,
        source: h.source
      })),
      log: state.log,
      lastCheckAt: state.lastCheckAt,
      lastOkAt: state.lastOkAt,
      lastError: state.lastError,
      needsNewBuild: state.needsNewBuild,
      hasUpdate: !!state.available,
      pinnedPubKey: Conf.PINNED_PUB_KEY || '',
      defaultChannelUrl: Conf.DEFAULT_CHANNEL_URL
    };
  }

  global.IAUpdater = {
    init: init,
    setChangeHook: function (fn) { changeHook = typeof fn === 'function' ? fn : null; },
    load: load,
    status: status,
    effective: async function () { await load(); return Core.effective(state, APP_VERSION); },
    check: check,
    maybeCheck: maybeCheck,
    applyAvailable: applyAvailable,
    rollback: rollback,
    factoryReset: factoryReset,
    setLocalPatch: setLocalPatch,
    setPrefs: setPrefs,
    setPublisher: setPublisher,
    importManual: importManual,
    buildChannel: buildChannel,
    publish: publish,
    testPublisher: testPublisher,
    log: log,
    schedule: schedule,
    currentVersion: currentVersion,
    bumpVersion: bumpVersion
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
