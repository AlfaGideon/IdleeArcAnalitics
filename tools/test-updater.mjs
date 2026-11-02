#!/usr/bin/env node
/*
 * Интеграционный тест OTA-клиента: поднимает ota-updater.js в Node с
 * эмуляцией chrome.* и fetch, и прогоняет реальные сценарии:
 *   проверка канала → применение → локальная правка → импорт → откат →
 *   сборка документа → публикация в GitHub → сброс.
 *
 *   node tools/test-updater.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const channelText = read('ota/update.json');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------- мок браузера -------------------------- */
const store = {};
const messages = [];
const requests = [];
const github = { put: 0, get: 0, lastBody: null };

const chrome = {
  runtime: {
    lastError: null,
    getManifest: () => ({ version: '1.1.0' }),
    getURL: (p) => 'chrome-extension://test/' + p,
    sendMessage: (m, cb) => { messages.push(m); if (cb) cb(null); return Promise.resolve(); },
    onMessage: { addListener() {} }
  },
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(store));
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (obj) => { Object.assign(store, obj); },
      onChanged: { addListener() {} }
    }
  },
  tabs: {
    query: (opts, cb) => { if (typeof opts === 'function') cb = opts; if (cb) cb([]); return Promise.resolve([]); },
    sendMessage() {}, reload() {}, create() {}, update() {}
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  scripting: { executeScript: async () => [{ result: 'ok' }] },
  permissions: { contains: async () => true, request: async () => true }
};

async function fakeFetch(url, opts) {
  requests.push({ url: String(url), method: (opts && opts.method) || 'GET' });
  const u = new URL(String(url));
  if (u.hostname === 'api.github.com') {
    const method = (opts && opts.method) || 'GET';
    if (method === 'PUT') {
      github.put++;
      github.lastBody = JSON.parse(opts.body);
      return { ok: true, text: async () => JSON.stringify({ content: {} }) };
    }
    github.get++;
    if (github.put === 0 && github.get === 1 && process.env.TEST_GH_404) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'Not Found' }) };
    }
    return { ok: true, text: async () => JSON.stringify({ sha: 'existing-sha' }) };
  }
  if (u.hostname === 'raw.githubusercontent.com') {
    return { ok: true, status: 200, text: async () => channelText };
  }
  return { ok: false, status: 404, text: async () => '{}' };
}

const sandbox = {
  console,
  chrome,
  fetch: fakeFetch,
  crypto: webcrypto,
  TextEncoder, TextDecoder,
  Buffer,
  URL, AbortController, Date, Math, JSON,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  setTimeout, clearTimeout, setInterval, clearInterval
};
vm.createContext(sandbox);
for (const f of ['stats.js', 'ota-config.js', 'ota-core.js', 'ota-updater.js']) {
  vm.runInContext(read(f), sandbox, { filename: f });
}
const OTA = sandbox.IAUpdater;
const Core = sandbox.IAOTACore;
ok('IAUpdater загрузился', !!OTA);
ok('IAS на месте', !!sandbox.IAS && typeof sandbox.IAS.applyRemoteConfig === 'function');

/* -------------------------- сценарии -------------------------- */
console.log('\n[1] Старт и проверка канала');
await OTA.init(() => {});
await wait(1000);                      // ждём фоновую maybeCheck('startup')
let s = await OTA.status();
ok('канал автоматически проверен', s.lastCheckAt > 0);
ok('документ применён', s.applied && s.applied.version === '1.1.0', JSON.stringify(s.lastError));
ok('хэш принят', s.applied && s.applied.signature.hashOk === true);
ok('ошибок нет', !s.lastError, s.lastError);
ok('эффективные настройки из канала', s.effective.settings.capture.limitPerMinute === 400);

let r = await OTA.check(true, 'test');
ok('повторная ручная проверка: актуально', r.ok && !r.updated, JSON.stringify(r));
ok('кеш-бастер в запросе', requests.some((x) => x.url.includes('_=')));

console.log('\n[2] Локальные правки');
r = await OTA.setLocalPatch({
  settings: { capture: { limitPerMinute: 123 } },
  patch: { metrics: { strength: { label: 'Сила!' } } },
  announcement: { level: 'warn', text: 'Внимание' },
  note: 'тест'
});
ok('правка сохранена', r.ok);
s = await OTA.status();
ok('локальное значение применилось', s.effective.settings.capture.limitPerMinute === 123);
ok('незатронутые настройки канала не сброшены', s.effective.settings.background.snapshotMinGapSec === 60);
ok('источник = local', s.effective.source === 'local');
ok('объявление из правки', s.effective.announcement.text === 'Внимание');
ok('IAS подхватил подпись метрики', sandbox.IAS.METRICS.strength.label === 'Сила!');
await OTA.setLocalPatch(null);
s = await OTA.status();
ok('сброс локальной правки вернул канал', s.effective.source === 'channel' &&
  s.effective.settings.capture.limitPerMinute === 400);

console.log('\n[3] Ручной импорт и откат');
const manual = JSON.parse(channelText);
manual.version = '1.1.3';
manual.settings = { overlay: { title: 'Ручной канал' } };
const signedManual = await Core.signPayload(manual, null);
r = await OTA.importManual(JSON.stringify(signedManual));
ok('импорт применён', r.ok, r.error);
s = await OTA.status();
ok('версия обновилась', s.applied.version === '1.1.3');
ok('заголовок из импорта', s.effective.settings.overlay.title === 'Ручной канал');
ok('история не пуста', s.history.length >= 1);
r = await OTA.rollback();
ok('откат выполнен', r.ok, r.error);
s = await OTA.status();
ok('вернулась предыдущая версия', s.applied.version === '1.1.0', s.applied.version);
r = await OTA.importManual('{ сломанный json');
ok('битый JSON отклонён', !r.ok);

console.log('\n[4] Сборка и публикация документа');
const doc = Core.template('1.1.4');
doc.settings = { overlay: { title: 'Из расширения' } };
doc.changelog = ['Тест публикации'];
const built = await OTA.buildChannel(doc);
ok('документ собран', built.ok, built.error);
ok('хеш посчитан', !!built.document.integrity.sha256);
const ver = await Core.verifyPayload(built.document, '');
ok('собранный хеш верен', ver.hashOk);
ok('версия не потеряна', built.document.version === '1.1.4');

await OTA.setPublisher({
  owner: 'AlfaGideon', repo: 'IdleeArcAnalitics', branch: 'main',
  path: 'ota/update.json', token: 'test-token'
});
r = await OTA.testPublisher();
ok('проверка доступа к GitHub', r.ok, r.error);
r = await OTA.publish(doc);
ok('публикация успешна', r.ok, r.error);
ok('был PUT с base64-содержимым', github.put === 1 && !!github.lastBody.content);
ok('в коммите указана версия', /v1\.1\.4/.test(github.lastBody.message));
const decoded = Buffer.from(github.lastBody.content, 'base64').toString('utf8');
ok('опубликован валидный JSON', (() => { try { return JSON.parse(decoded).version === '1.1.4'; } catch (e) { return false; } })());
ok('секреты не попали в статус', !('token' in (await OTA.status()).publisher));

console.log('\n[5] Настройки и сброс');
r = await OTA.setPrefs({ channelUrl: 'http://insecure.example/update.json' });
ok('http отклонён', !r.ok);
r = await OTA.setPrefs({ channelUrl: 'https://example.com/ota.json', checkIntervalMin: 1 });
ok('https принят', r.ok);
s = await OTA.status();
ok('интервал ограничен минимумом', s.prefs.checkIntervalMin >= 5);
r = await OTA.factoryReset();
s = await OTA.status();
ok('сброс убрал применённый документ', !s.applied && !s.localPatch);
ok('после сброса — заводские настройки', s.effective.source === 'builtin' &&
  s.effective.settings.capture.limitPerMinute === 400);
ok('история сохранилась для отката', s.history.length >= 1);

// отложенная проверка после публикации может ещё раз дёрнуть fetch — даем ей завершиться
await wait(1700);
console.log('\nРезультат: ' + passed + ' проверок пройдено, ' + failed + ' провалено\n');
process.exit(failed ? 1 : 0);
