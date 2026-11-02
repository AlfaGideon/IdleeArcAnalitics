/*
 * IdleArc Analyst — фоновый service worker.
 * Принимает перехваченные данные, схлопывает их в «наблюдения»,
 * качает публичный конфиг игры, отвечает на запросы UI
 * и применяет OTA-правки (ota-updater.js).
 */
importScripts('stats.js', 'ota-config.js', 'ota-core.js', 'ota-updater.js');

const IAS = self.IAS;
const OTA = self.IAUpdater;
const API = 'https://idlearc.com/api';

/* Все лимиты теперь живые: их можно менять удалённо без переустановки расширения. */
function settings() {
  return (self.IAOTACore ? self.IAOTACore.DEFAULT_SETTINGS : null) || {};
}
let liveSettings = settings();
function applyLiveSettings(eff) {
  liveSettings = (eff && eff.settings) || settings();
  if (IAS && typeof IAS.applyRemoteConfig === 'function') {
    try { IAS.applyRemoteConfig(eff && eff.patch); } catch (e) { /* ignore */ }
  }
}
OTA.setChangeHook((eff) => applyLiveSettings(eff));
const cfgBackground = () => (liveSettings.background || settings().background || {});
const CONFIG_TTL = () => (cfgBackground().configTtlHours || 6) * 60 * 60 * 1000;
const SNAPSHOT_MIN_GAP = () => (cfgBackground().snapshotMinGapSec != null
  ? cfgBackground().snapshotMinGapSec : 60) * 1000;
const MAX_SNAPSHOTS = () => cfgBackground().maxSnapshots || 5000;
const MAX_RAW = () => cfgBackground().maxRaw || 300;

/* ------------------------------------------------------------------ *
 * Хранилище (chrome.storage.local, с кэшем в памяти)
 * ------------------------------------------------------------------ */
const DEFAULTS = {
  enabled: true,
  snapshots: [],          // [{t, stats, source}]
  selected: [],           // выбранные метрики для быстрого просмотра
  raw: [],                // последние сырые перехваты
  configCache: null,      // {fetchedAt, data}
  lastCaptureAt: 0,
  counters: { captures: 0, snapshots: 0 }
};

let cache = null;
let saveTimer = null;
let pendingWrite = false;

/* ВАЖНО: читаем/пишем только свои ключи. Раньше здесь был get(null)/set(cache),
 * что затирало бы состояние OTA (ключ 'ota'), записанное updater'ом. */
const DATA_KEYS = Object.keys(DEFAULTS);

async function load() {
  if (cache) return cache;
  const got = await chrome.storage.local.get(DATA_KEYS);
  cache = Object.assign({}, DEFAULTS, got);
  if (!Array.isArray(cache.snapshots)) cache.snapshots = [];
  if (!Array.isArray(cache.raw)) cache.raw = [];
  return cache;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!cache) return;
    const data = {};
    for (const k of DATA_KEYS) data[k] = cache[k];
    await chrome.storage.local.set(data);
    pendingWrite = false;
  }, 700);
  pendingWrite = true;
}

/* ------------------------------------------------------------------ *
 * Резервное внедрение (Android: статические content_scripts могут не грузиться)
 * ------------------------------------------------------------------ */
const INJECT_FILES = ['stats.js', 'content.js', 'overlay.js'];

async function ensureInjected(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });
    return true;
  } catch (e) {
    return false; // уже внедрено или страница не подходит — это нормально
  }
}

function isGameUrl(url) {
  return /^https:\/\/(staging\.)?idlearc\.com\//.test(url || '');
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!isGameUrl(tab && tab.url)) return;
  ensureInjected(tabId);
  // На Android/Yandex alarms часто не срабатывают — проверяем канал
  // при каждом открытии игры (внутри maybeCheck есть throttle по интервалу).
  OTA.maybeCheck('game-tab').catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'ia:reinject' && sender.tab) {
    ensureInjected(sender.tab.id).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg.type === 'ia:page-ready') {
    OTA.maybeCheck('page-ready').catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ia:ota-run-hook' && sender.tab) {
    // Удалённый hookCode: пробуем выполнить в MAIN world через chrome.scripting.
    // Если eval запрещён CSP страницы — content.js откатится на <script> или
    // на встроенный inject.js.
    runHook(sender.tab.id, msg.code, msg.gen).then(sendResponse);
    return true;
  }
});

/** Попытка выполнить OTA-код в главном мире страницы. */
async function runHook(tabId, code, gen) {
  if (!chrome.scripting || !chrome.scripting.executeScript || typeof code !== 'string') {
    return { ok: false, error: 'scripting недоступен' };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: (src, generation) => {
        try {
          (0, eval)(src);
          window.__IA_OTA_HOOK_OK = generation;
          return 'ok';
        } catch (e) {
          return 'error: ' + String(e && e.message || e);
        }
      },
      args: [code, gen]
    });
    const value = results && results[0] && results[0].result;
    return { ok: value === 'ok', result: String(value || '') };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ------------------------------------------------------------------ *
 * Установка / обновление / запуск OTA
 * ------------------------------------------------------------------ */
chrome.runtime.onInstalled.addListener(async () => {
  await load();
  fetchConfig(true).catch(() => {});
  await OTA.init(broadcast);
  applyLiveSettings(await OTA.effective());
  OTA.check(true, 'install').catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  await load();
  await OTA.init(broadcast);
  applyLiveSettings(await OTA.effective());
});

/* Service worker может подняться и без onStartup (например, по сообщению). */
(async function bootOta() {
  try {
    await OTA.init(broadcast);
    applyLiveSettings(await OTA.effective());
  } catch (e) { /* ignore */ }
})();

/* ------------------------------------------------------------------ *
 * Конфиг игры (публичный, без авторизации)
 * ------------------------------------------------------------------ */
async function fetchConfig(force) {
  const st = await load();
  const c = st.configCache;
  if (!force && c && Date.now() - c.fetchedAt < CONFIG_TTL()) return c;
  try {
    const res = await fetch(API + '/config/game', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    st.configCache = { fetchedAt: Date.now(), data };
    scheduleSave();
    return st.configCache;
  } catch (e) {
    return c || null;
  }
}

/* ------------------------------------------------------------------ *
 * Схлопывание перехватов в наблюдения
 * ------------------------------------------------------------------ */
function snapshotFrom(body) {
  const stats = IAS.normalizeStats(body);
  const keys = Object.keys(stats);
  if (!keys.length) return null;
  // «насыщенный» снимок — где есть хотя бы один ключевой боевой стат
  const meaningful = keys.some((k) =>
    ['attack_damage_avg', 'max_hp', 'dps', 'defense', 'strength', 'level', 'crit_chance'].includes(k));
  if (!meaningful) return null;
  return stats;
}

async function maybeSnapshot(stats, source) {
  const st = await load();
  if (!st.enabled) return false;

  const prev = st.snapshots[st.snapshots.length - 1];
  const same = prev && deepEqualStats(prev.stats, stats);
  if (same) return false;
  if (prev && Date.now() - prev.t < 3000 && shallowSame(prev.stats, stats)) return false;

  const auto = source === 'auto';
  if (auto && Date.now() - (st.lastCaptureAt || 0) < SNAPSHOT_MIN_GAP()) return false;

  st.snapshots.push({ t: Date.now(), stats, source: source || 'auto' });
  if (st.snapshots.length > MAX_SNAPSHOTS()) st.snapshots = st.snapshots.slice(-MAX_SNAPSHOTS());
  st.lastCaptureAt = Date.now();
  st.counters.snapshots = (st.counters.snapshots || 0) + 1;
  scheduleSave();
  broadcast({ type: 'ia:snapshot-added', snapshot: st.snapshots[st.snapshots.length - 1] });
  return true;
}

function deepEqualStats(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
function shallowSame(a, b) {
  const ka = Object.keys(a).filter((k) => k in b);
  if (!ka.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/* ------------------------------------------------------------------ *
 * Сообщения из UI / контент-скрипта
 * ------------------------------------------------------------------ */
const BRIDGE_MESSAGES = ['ia:reinject', 'ia:page-ready', 'ia:ota-run-hook'];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Эти сообщения уже обработаны первым слушателем; иначе «default» ответил бы
  // раньше асинхронного ответа chrome.scripting.executeScript.
  if (msg && BRIDGE_MESSAGES.indexOf(msg.type) >= 0) return;
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'ia:capture': {
          const st = await load();
          if (!st.enabled) return sendResponse({ ok: false, disabled: true });
          const p = msg.payload || {};
          st.raw.push({ at: p.at || Date.now(), path: p.path, method: p.method, body: p.body });
          if (st.raw.length > MAX_RAW()) st.raw = st.raw.slice(-MAX_RAW());
          st.counters.captures = (st.counters.captures || 0) + 1;
          scheduleSave();
          const stats = p.body ? snapshotFrom(p.body) : null;
          const added = stats ? await maybeSnapshot(stats, 'auto') : false;
          return sendResponse({ ok: true, added, stats: stats || null });
        }

        case 'ia:state': {
          const st = await load();
          let otaBrief = null;
          try {
            const s = await OTA.status();
            otaBrief = {
              version: s.effective.version,
              installedVersion: s.installedVersion,
              source: s.effective.source,
              hasUpdate: s.hasUpdate,
              availableVersion: s.available ? s.available.version : null,
              showBanner: !!(s.effective.settings.ui && s.effective.settings.ui.showUpdateBanner),
              showVersion: !!(s.effective.settings.ui && s.effective.settings.ui.showVersion),
              announcement: s.effective.announcement
            };
          } catch (e) { /* OTA не должен ломать основной попап */ }
          return sendResponse({
            ok: true,
            enabled: st.enabled,
            snapshots: st.snapshots,
            selected: st.selected,
            counters: st.counters,
            raw: st.raw.slice(-10),
            hasConfig: !!st.configCache,
            configAge: st.configCache ? Date.now() - st.configCache.fetchedAt : null,
            ota: otaBrief
          });
        }

        case 'ia:set-enabled': {
          const st = await load();
          st.enabled = !!msg.value;
          scheduleSave();
          return sendResponse({ ok: true, enabled: st.enabled });
        }

        case 'ia:add-snapshot': {
          // ручной ввод из попапа/оверлея
          const stats = msg.stats || {};
          if (!Object.keys(stats).length) return sendResponse({ ok: false, error: 'empty' });
          const st = await load();
          st.snapshots.push({ t: Date.now(), stats, source: msg.source || 'manual' });
          if (st.snapshots.length > MAX_SNAPSHOTS()) st.snapshots = st.snapshots.slice(-MAX_SNAPSHOTS());
          st.counters.snapshots = (st.counters.snapshots || 0) + 1;
          scheduleSave();
          return sendResponse({ ok: true, count: st.snapshots.length });
        }

        case 'ia:delete-snapshot': {
          const st = await load();
          st.snapshots = st.snapshots.filter((_, i) => i !== msg.index);
          scheduleSave();
          return sendResponse({ ok: true, snapshots: st.snapshots });
        }

        case 'ia:clear': {
          const st = await load();
          st.snapshots = [];
          st.raw = [];
          st.counters.snapshots = 0;
          scheduleSave();
          return sendResponse({ ok: true });
        }

        case 'ia:set-selected': {
          const st = await load();
          st.selected = Array.isArray(msg.value) ? msg.value.slice(0, 8) : [];
          scheduleSave();
          return sendResponse({ ok: true, selected: st.selected });
        }

        case 'ia:config': {
          const c = await fetchConfig(msg.force);
          return sendResponse({ ok: !!c, config: c ? c.data : null, fetchedAt: c ? c.fetchedAt : null });
        }

        case 'ia:export': {
          const st = await load();
          return sendResponse({
            ok: true,
            data: {
              app: 'IdleArc Analyst',
              version: IAS.VERSION,
              exportedAt: new Date().toISOString(),
              snapshots: st.snapshots,
              selected: st.selected
            }
          });
        }

        case 'ia:import': {
          const st = await load();
          const incoming = (msg.data && msg.data.snapshots) || [];
          let added = 0;
          for (const s of incoming) {
            if (!s || !s.stats || typeof s.t !== 'number') continue;
            const stats = {};
            for (const [k, v] of Object.entries(s.stats)) {
              const n = IAS.parseNum(v);
              if (n != null) stats[k] = n;
            }
            if (!Object.keys(stats).length) continue;
            st.snapshots.push({ t: s.t, stats, source: s.source || 'import' });
            added++;
          }
          st.snapshots.sort((a, b) => a.t - b.t);
          scheduleSave();
          return sendResponse({ ok: true, added, total: st.snapshots.length });
        }

        case 'ia:open-popup': {
          if (chrome.action && chrome.action.openPopup) {
            try { await chrome.action.openPopup(); } catch (e) { /* не всегда разрешено */ }
          }
          return sendResponse({ ok: true });
        }

        /* ------------------------- OTA ------------------------------ */
        case 'ia:ota-status':
          return sendResponse(await OTA.status());

        case 'ia:ota-effective':
          return sendResponse({ ok: true, config: await OTA.effective() });

        case 'ia:ota-check': {
          const r = await OTA.check(true, 'manual');
          applyLiveSettings(await OTA.effective());
          return sendResponse(r);
        }
        case 'ia:ota-apply': {
          const r = await OTA.applyAvailable();
          applyLiveSettings(await OTA.effective());
          return sendResponse(r);
        }
        case 'ia:ota-rollback': {
          const r = await OTA.rollback();
          applyLiveSettings(await OTA.effective());
          return sendResponse(r);
        }
        case 'ia:ota-reset': {
          const r = await OTA.factoryReset();
          applyLiveSettings(await OTA.effective());
          return sendResponse(r);
        }
        case 'ia:ota-local': {
          const r = await OTA.setLocalPatch(msg.patch);
          applyLiveSettings(await OTA.effective());
          return sendResponse(r);
        }
        case 'ia:ota-prefs':
          return sendResponse(await OTA.setPrefs(msg.prefs || {}));
        case 'ia:ota-publisher':
          return sendResponse(await OTA.setPublisher(msg.publisher || {}));
        case 'ia:ota-import': {
          const r = await OTA.importManual(msg.text || '');
          applyLiveSettings(await OTA.effective());
          return sendResponse(r);
        }
        case 'ia:ota-build':
          return sendResponse(await OTA.buildChannel(msg.document || {}));
        case 'ia:ota-publish': {
          const r = await OTA.publish(msg.document || {});
          applyLiveSettings(await OTA.effective());
          return sendResponse(r);
        }
        case 'ia:ota-test-publisher':
          return sendResponse(await OTA.testPublisher());

        case 'ia:ota-open': {
          const url = chrome.runtime.getURL('ota.html');
          let opened = false;
          try {
            const tabs = await chrome.tabs.query({ url: url });
            if (tabs && tabs.length) {
              await chrome.tabs.update(tabs[0].id, { active: true });
              opened = true;
            }
          } catch (e) { /* url-фильтр поддерживается не везде */ }
          if (!opened) await chrome.tabs.create({ url: url });
          return sendResponse({ ok: true });
        }

        case 'ia:ota-reload-tabs': {
          let n = 0;
          try {
            const tabs = await chrome.tabs.query({});
            for (const t of tabs || []) {
              if (t.id && isGameUrl(t.url)) { await chrome.tabs.reload(t.id); n++; }
            }
          } catch (e) { /* ignore */ }
          return sendResponse({ ok: true, reloaded: n });
        }

        default:
          return sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // асинхронный ответ
});

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
