/*
 * IdleArc Analyst — ядро OTA (обновления по воздуху).
 *
 * Обычный скрипт (не ES-модуль): подключается в service worker через importScripts,
 * в страницы расширения через <script src>, а в Node — через tools/load-core.mjs.
 * Содержит ТОЛЬКО чистую логику без chrome.* API, поэтому её можно тестировать
 * в Node и использовать и в фоне, и в UI.
 *
 * Экспорт: globalThis.IAOTACore
 */
(function (global) {
  'use strict';

  const enc = new TextEncoder();

  /* ------------------------------------------------------------------ *
   * Значения по умолчанию. Именно сюда «приземляются» удалённые правки.
   * Все эти поля можно менять через update.json или редактор в расширении.
   * ------------------------------------------------------------------ */
  const DEFAULT_SETTINGS = {
    background: {
      configTtlHours: 6,          // как часто перекачивать конфиг игры
      snapshotMinGapSec: 60,      // минимальный интервал между автоснимками
      maxSnapshots: 5000,
      maxRaw: 300
    },
    capture: {
      limitPerMinute: 400,        // throttle перехватов в контент-скрипте
      maxSampleBytes: 262144,     // лимит размера образца ответа
      relevantPattern: 'combatStats|bonusStats|attackDamage|maxHealth|stateUpdates|player_dps|combat_live|dps|kills_per_min|monsterLevel|skillPoints',
      wsPattern: 'combat_live|player_dps|stateUpdates|dps|monster|stats',
      extraApiPaths: [],          // дополнительные /api/* пути, которые точно интересны
      enableFetch: true,
      enableXHR: true,
      enableWS: true
    },
    overlay: {
      showFab: true,
      title: 'IdleArc Analyst',
      refreshMs: 6000,
      showAnnouncement: true
    },
    ui: {
      showUpdateBanner: true,
      showVersion: true
    }
  };

  const LIMITS = {
    maxPayloadChars: 512 * 1024,
    maxHookChars: 200 * 1024,
    maxCssChars: 64 * 1024,
    maxSynonyms: 500,
    maxMetrics: 200,
    maxLabelHints: 100,
    maxExtraPaths: 100,
    maxChangelog: 50
  };

  /* ------------------------------------------------------------------ *
   * Утилиты
   * ------------------------------------------------------------------ */
  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }

  function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** Рекурсивное слияние: только для простых объектов, массивы заменяются целиком. */
  function deepMerge(base, extra) {
    const out = clone(base) || {};
    if (!isObj(extra)) return out;
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (v === undefined) continue;
      if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = clone(v);
    }
    return out;
  }

  /**
   * Каноническая сериализация: ключи отсортированы на всех уровнях.
   * Одинакова в Node и в браузере — на ней строятся хэш и подпись.
   */
  function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map((v) => canonicalStringify(v === undefined ? null : v)).join(',') + ']';
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
  }

  function utf8(str) { return enc.encode(str); }

  function bytesToBase64(bytes) {
    let s = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(arr).toString('base64');
  }

  function base64ToBytes(b64) {
    let s;
    if (typeof atob === 'function') s = atob(b64);
    else s = Buffer.from(b64, 'base64').toString('binary');
    const arr = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
    return arr;
  }

  function pemToBytes(pem) {
    const body = String(pem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    if (!body) throw new Error('пустой PEM');
    return base64ToBytes(body);
  }

  function toHex(buf) {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function webcrypto() {
    const c = global.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    if (!c || !c.subtle) throw new Error('WebCrypto недоступен');
    return c.subtle;
  }

  async function sha256Hex(input) {
    const data = typeof input === 'string' ? utf8(input) : input;
    const digest = await webcrypto().digest('SHA-256', data);
    return toHex(digest);
  }

  /* ------------------------------------------------------------------ *
   * Целостность и подпись (ECDSA P-256 / ES256)
   * ------------------------------------------------------------------ */
  function stripIntegrity(payload) {
    const out = clone(payload) || {};
    delete out.integrity;
    return out;
  }

  async function signPayload(payload, privateKeyPem) {
    const unsigned = stripIntegrity(payload);
    const canonical = canonicalStringify(unsigned);
    const bytes = utf8(canonical);
    const sha256 = await sha256Hex(bytes);
    let signature = null;
    if (privateKeyPem) {
      const key = await webcrypto().importKey(
        'pkcs8', pemToBytes(privateKeyPem),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
      );
      const sig = await webcrypto().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes);
      signature = bytesToBase64(sig);
    }
    return Object.assign({}, unsigned, {
      integrity: { sha256: sha256, signature: signature, keyId: 'main' }
    });
  }

  /**
   * Проверяет sha256 канонического JSON и (если есть) подпись.
   * Возвращает { hashOk, signature: 'absent'|'valid'|'invalid'|'unverifiable'|'unsupported', detail }.
   */
  async function verifyPayload(payload, pubKeyBase64) {
    const canonical = canonicalStringify(stripIntegrity(payload));
    const bytes = utf8(canonical);
    let hashOk = false;
    try {
      const sha256 = await sha256Hex(bytes);
      hashOk = !!(payload && payload.integrity && payload.integrity.sha256 &&
        String(payload.integrity.sha256).toLowerCase() === sha256);
    } catch (e) { hashOk = false; }

    const sig = payload && payload.integrity && payload.integrity.signature;
    let status = 'absent';
    let detail = '';
    if (sig) {
      if (!pubKeyBase64) {
        status = 'unverifiable';
        detail = 'нет публичного ключа';
      } else {
        try {
          const key = await webcrypto().importKey(
            'spki', base64ToBytes(pubKeyBase64),
            { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
          );
          const ok = await webcrypto().verify(
            { name: 'ECDSA', hash: 'SHA-256' }, key, base64ToBytes(sig), bytes
          );
          status = ok ? 'valid' : 'invalid';
          if (!ok) detail = 'подпись не совпала';
        } catch (e) {
          status = 'unverifiable';
          detail = String(e && e.message || e);
        }
      }
    }
    return { hashOk: hashOk, signature: status, detail: detail, canonical: canonical };
  }

  /* ------------------------------------------------------------------ *
   * Версии
   * ------------------------------------------------------------------ */
  function parseVersion(v) {
    const s = String(v || '').trim();
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?/);
    if (!m) return null;
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] || ''
    };
  }

  /** -1 / 0 / 1. Релиз новее своей же pre-release версии. */
  function compareVersions(a, b) {
    const x = parseVersion(a), y = parseVersion(b);
    if (!x || !y) return 0;
    for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
    if (!x.pre && !y.pre) return 0;
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return x.pre > y.pre ? 1 : (x.pre < y.pre ? -1 : 0);
  }

  function isNewer(candidate, current) { return compareVersions(candidate, current) > 0; }

  /* ------------------------------------------------------------------ *
   * Валидация и «белый список» полей
   * ------------------------------------------------------------------ */
  function num(v, def, min, max) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function bool(v, def) { return typeof v === 'boolean' ? v : def; }
  function str(v, def, max) {
    return typeof v === 'string' && v.length <= max ? v : def;
  }

  function safeRegex(src, fallback, max) {
    if (typeof src !== 'string' || !src || src.length > max) return fallback;
    try { new RegExp(src, 'i'); return src; } catch (e) { return fallback; }
  }

  function pickSettings(raw) {
    const r = isObj(raw) ? raw : {};
    const b = r.background || {};
    const c = r.capture || {};
    const o = r.overlay || {};
    const u = r.ui || {};
    const D = DEFAULT_SETTINGS;
    const paths = Array.isArray(c.extraApiPaths)
      ? c.extraApiPaths.filter((p) => typeof p === 'string' && p.length <= 200).slice(0, LIMITS.maxExtraPaths)
      : D.capture.extraApiPaths;
    return {
      background: {
        configTtlHours: num(b.configTtlHours, D.background.configTtlHours, 0.1, 168),
        snapshotMinGapSec: num(b.snapshotMinGapSec, D.background.snapshotMinGapSec, 0, 3600),
        maxSnapshots: Math.round(num(b.maxSnapshots, D.background.maxSnapshots, 10, 20000)),
        maxRaw: Math.round(num(b.maxRaw, D.background.maxRaw, 10, 5000))
      },
      capture: {
        limitPerMinute: Math.round(num(c.limitPerMinute, D.capture.limitPerMinute, 10, 5000)),
        maxSampleBytes: Math.round(num(c.maxSampleBytes, D.capture.maxSampleBytes, 4096, 1048576)),
        relevantPattern: safeRegex(c.relevantPattern, D.capture.relevantPattern, 2000),
        wsPattern: safeRegex(c.wsPattern, D.capture.wsPattern, 2000),
        extraApiPaths: paths,
        enableFetch: bool(c.enableFetch, D.capture.enableFetch),
        enableXHR: bool(c.enableXHR, D.capture.enableXHR),
        enableWS: bool(c.enableWS, D.capture.enableWS)
      },
      overlay: {
        showFab: bool(o.showFab, D.overlay.showFab),
        title: str(o.title, D.overlay.title, 80),
        refreshMs: Math.round(num(o.refreshMs, D.overlay.refreshMs, 1000, 120000)),
        showAnnouncement: bool(o.showAnnouncement, D.overlay.showAnnouncement)
      },
      ui: {
        showUpdateBanner: bool(u.showUpdateBanner, D.ui.showUpdateBanner),
        showVersion: bool(u.showVersion, D.ui.showVersion)
      }
    };
  }

  const METRIC_KEY_RE = /^[a-z0-9_]{1,64}$/;

  function pickPatch(raw, warnings) {
    const r = isObj(raw) ? raw : {};
    const out = {};

    if (isObj(r.metrics)) {
      const metrics = {};
      const keys = Object.keys(r.metrics).slice(0, LIMITS.maxMetrics);
      for (const k of keys) {
        if (!METRIC_KEY_RE.test(k) || !isObj(r.metrics[k])) continue;
        const m = {};
        const v = r.metrics[k];
        if (typeof v.label === 'string') m.label = v.label.slice(0, 80);
        if (typeof v.unit === 'string') m.unit = v.unit.slice(0, 8);
        if (typeof v.group === 'string') m.group = v.group.slice(0, 40);
        if (typeof v.icon === 'string') m.icon = v.icon.slice(0, 8);
        if (Object.keys(m).length) metrics[k] = m;
      }
      if (Object.keys(metrics).length) out.metrics = metrics;
    }

    if (isObj(r.synonyms)) {
      const syn = {};
      const keys = Object.keys(r.synonyms).slice(0, LIMITS.maxSynonyms);
      for (const k of keys) {
        const norm = String(k).toLowerCase().replace(/[^a-z0-9а-я_]/gi, '');
        const target = r.synonyms[k];
        if (!norm || norm.length > 64 || typeof target !== 'string' || !METRIC_KEY_RE.test(target)) continue;
        syn[norm] = target;
      }
      if (Object.keys(syn).length) out.synonyms = syn;
    }

    if (Array.isArray(r.labelHints)) {
      const hints = [];
      for (const h of r.labelHints.slice(0, LIMITS.maxLabelHints)) {
        if (!Array.isArray(h) || typeof h[0] !== 'string' || !METRIC_KEY_RE.test(h[1] || '')) continue;
        try { new RegExp(h[0], String(h[2] || 'i')); } catch (e) { continue; }
        hints.push([h[0].slice(0, 300), h[1], String(h[2] || 'i').slice(0, 8)]);
      }
      if (hints.length) out.labelHints = hints;
    }

    if (typeof r.overlayCss === 'string' && r.overlayCss.length) {
      const css = r.overlayCss.slice(0, LIMITS.maxCssChars);
      if (/<\/style|javascript:|expression\(|@import/i.test(css)) {
        warnings.push('overlayCss: опасные конструкции вырезаны');
      } else {
        out.overlayCss = css;
      }
    }

    if (r.hookCode === '') {
      out.hookCode = '';                   // явное «отключить удалённый перехватчик»
    } else if (typeof r.hookCode === 'string' && r.hookCode.length) {
      if (r.hookCode.length > LIMITS.maxHookChars) {
        warnings.push('hookCode слишком большой — проигнорирован');
      } else {
        out.hookCode = r.hookCode;
      }
    }

    if (isObj(r.features)) {
      const f = {};
      for (const k of Object.keys(r.features).slice(0, 50)) {
        if (typeof r.features[k] === 'boolean' && METRIC_KEY_RE.test(k)) f[k] = r.features[k];
      }
      if (Object.keys(f).length) out.features = f;
    }
    return out;
  }

  function pickAnnouncement(raw) {
    if (!isObj(raw) || typeof raw.text !== 'string' || !raw.text.trim()) return null;
    const level = ['info', 'warn', 'ok', 'bad'].includes(raw.level) ? raw.level : 'info';
    return { level: level, text: raw.text.slice(0, 500) };
  }

  /**
   * Полная проверка входящего документа канала.
   * opts: { extensionVersion, fromRemote, requireSignature, allowUnsignedCode, signatureStatus }
   */
  async function validate(payload, opts) {
    opts = opts || {};
    const warnings = [];
    if (!isObj(payload)) return { ok: false, error: 'это не JSON-объект', warnings: warnings };
    const text = JSON.stringify(payload);
    if (text.length > LIMITS.maxPayloadChars) {
      return { ok: false, error: 'документ больше 512 КБ', warnings: warnings };
    }
    if (payload.schema !== undefined && payload.schema !== 1) {
      return { ok: false, error: 'неподдерживаемая schema: ' + payload.schema, warnings: warnings };
    }
    if (payload.app && payload.app !== 'IdleArc Analyst') {
      return { ok: false, error: 'документ предназначен для другого расширения', warnings: warnings };
    }
    if (!parseVersion(payload.version)) {
      return { ok: false, error: 'нет корректного поля version (x.y.z)', warnings: warnings };
    }
    if (payload.minExtension && opts.extensionVersion &&
        compareVersions(opts.extensionVersion, payload.minExtension) < 0) {
      return {
        ok: false, needsNewBuild: true,
        error: 'требуется расширение v' + payload.minExtension + ' или новее (сейчас v' + opts.extensionVersion + ')',
        warnings: warnings
      };
    }
    if (payload.maxExtension && opts.extensionVersion &&
        compareVersions(opts.extensionVersion, payload.maxExtension) > 0) {
      warnings.push('документ помечен как устаревший для этой версии расширения');
    }

    // Целостность обязательна для удалённых документов
    let integrity = null;
    if (opts.integrity) integrity = opts.integrity;
    else if (payload.integrity) integrity = await verifyPayload(payload, opts.pubKey);
    if (opts.fromRemote) {
      if (!integrity || !integrity.hashOk) {
        return { ok: false, error: 'хеш SHA-256 не совпал (документ повреждён или изменён вручную)', warnings: warnings };
      }
      if (opts.requireSignature && (!integrity || integrity.signature !== 'valid')) {
        return { ok: false, error: 'нужна действующая подпись канала', warnings: warnings };
      }
      if (integrity.signature === 'invalid') {
        return { ok: false, error: 'подпись канала недействительна', warnings: warnings };
      }
      if (integrity.signature === 'unverifiable') warnings.push('подпись есть, но проверить её не удалось: ' + (integrity.detail || ''));
      if (integrity.signature === 'absent') warnings.push('канал не подписан');
    }

    const patch = pickPatch(payload.patch, warnings);

    // Удалённый произвольный JS допускаем только из подписанного канала
    if (opts.fromRemote && patch.hookCode && !opts.allowUnsignedCode &&
        (!integrity || integrity.signature !== 'valid')) {
      delete patch.hookCode;
      warnings.push('удалённый hookCode отключён политикой (нужна подпись или разрешение в настройках)');
    }

    const changelog = Array.isArray(payload.changelog)
      ? payload.changelog.filter((s) => typeof s === 'string').slice(0, LIMITS.maxChangelog).map((s) => s.slice(0, 500))
      : [];

    const clean = {
      schema: 1,
      app: 'IdleArc Analyst',
      channel: str(payload.channel, 'stable', 40),
      version: String(payload.version).trim(),
      publishedAt: typeof payload.publishedAt === 'string' ? payload.publishedAt.slice(0, 40) : null,
      minExtension: typeof payload.minExtension === 'string' ? payload.minExtension.slice(0, 20) : null,
      maxExtension: typeof payload.maxExtension === 'string' ? payload.maxExtension.slice(0, 20) : null,
      notes: str(payload.notes, '', 2000),
      changelog: changelog,
      announcement: pickAnnouncement(payload.announcement),
      settings: pickSettings(payload.settings),
      patch: patch
    };
    return { ok: true, payload: clean, warnings: warnings, integrity: integrity };
  }

  /* ------------------------------------------------------------------ *
   * Локальные правки (введённые прямо в расширении) — им доверяем всегда
   * ------------------------------------------------------------------ */
  /** Оставляет в провалидированном объекте только явно переданные ключи. */
  function sparse(raw, full) {
    if (!isObj(raw) || !isObj(full)) return {};
    const out = {};
    for (const k of Object.keys(raw)) {
      if (!(k in full)) continue;
      out[k] = isObj(raw[k]) && isObj(full[k]) ? sparse(raw[k], full[k]) : full[k];
    }
    return out;
  }

  function pickLocalPatch(raw) {
    if (!isObj(raw)) return null;
    const warnings = [];
    const patch = pickPatch(raw.patch, warnings);
    // ВАЖНО: локальная правка «разреженная» — незаданные поля не должны
    // перезаписывать настройки канала заводскими значениями.
    const settings = isObj(raw.settings) ? sparse(raw.settings, pickSettings(raw.settings)) : {};
    const out = {
      settings: settings,
      patch: patch,
      announcement: pickAnnouncement(raw.announcement),
      warnings: warnings
    };
    if (typeof raw.note === 'string') out.note = raw.note.slice(0, 300);
    if (typeof raw.version === 'string') out.version = raw.version.slice(0, 20);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Эффективная конфигурация, которую получают все части расширения
   * ------------------------------------------------------------------ */
  function effective(state, extensionVersion) {
    const s = state || {};
    const applied = s.applied && s.applied.payload ? s.applied : null;
    const local = s.localPatch || null;
    const settings = deepMerge(DEFAULT_SETTINGS, applied ? applied.payload.settings : {});
    if (local) Object.assign(settings, deepMerge(settings, local.settings));
    const patch = deepMerge(applied ? applied.payload.patch : {}, local ? local.patch : {});
    // Если локальная правка явно отключила удалённый код
    if (local && Object.prototype.hasOwnProperty.call(local.patch || {}, 'hookCode') && !local.patch.hookCode) {
      delete patch.hookCode;
    }
    const announcement = (local && local.announcement !== undefined)
      ? local.announcement
      : (applied ? applied.payload.announcement : null);
    return {
      extensionVersion: extensionVersion || null,
      otaVersion: applied ? applied.payload.version : null,
      localVersion: local && local.version ? local.version : null,
      version: (local && local.version) || (applied && applied.payload.version) || extensionVersion || '1.1.0',
      source: local ? 'local' : (applied ? 'channel' : 'builtin'),
      channel: applied ? applied.payload.channel : 'stable',
      appliedAt: applied ? applied.appliedAt : null,
      publishedAt: applied ? applied.payload.publishedAt : null,
      signature: applied ? applied.signature : null,
      changelog: applied ? applied.payload.changelog : [],
      notes: applied ? applied.payload.notes : '',
      settings: settings,
      patch: patch,
      announcement: announcement || null,
      warnings: (local && local.warnings) || []
    };
  }

  /* ------------------------------------------------------------------ *
   * Пустой документ канала для редактора
   * ------------------------------------------------------------------ */
  function template(version) {
    return {
      schema: 1,
      app: 'IdleArc Analyst',
      channel: 'stable',
      version: version || '1.1.1',
      publishedAt: new Date().toISOString(),
      minExtension: '1.1.0',
      changelog: ['Описание правки'],
      notes: '',
      announcement: { level: 'info', text: '' },
      settings: {},
      patch: {}
    };
  }

  global.IAOTACore = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    LIMITS: LIMITS,
    clone: clone,
    isObj: isObj,
    deepMerge: deepMerge,
    canonicalStringify: canonicalStringify,
    sha256Hex: sha256Hex,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    pemToBytes: pemToBytes,
    stripIntegrity: stripIntegrity,
    signPayload: signPayload,
    verifyPayload: verifyPayload,
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    isNewer: isNewer,
    validate: validate,
    pickSettings: pickSettings,
    pickLocalPatch: pickLocalPatch,
    effective: effective,
    template: template
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
