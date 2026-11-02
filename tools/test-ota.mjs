#!/usr/bin/env node
/*
 * Самопроверка OTA-подсистемы без браузера:
 *   node tools/test-ota.mjs
 *
 * Проверяет совпадение канонического JSON/хэша/подписи между инструментами и
 * расширением, политику безопасности, «разреженные» локальные правки,
 * синтаксис всех JS-файлов и ссылки из manifest/HTML.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { root, loadCore, readJson } from './load-core.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

const sandbox = loadCore();
const Core = sandbox.IAOTACore;
const Conf = sandbox.IAOTAConfig;

console.log('\n[1] Ядро и каноническая сериализация');
ok('IAOTACore загрузился', !!Core);
ok('IAOTAConfig загрузился', !!Conf && /^https:\/\//.test(Conf.DEFAULT_CHANNEL_URL));
ok('ключи сортируются', Core.canonicalStringify({ b: 1, a: { d: 2, c: 3 } }) === '{"a":{"c":3,"d":2},"b":1}',
  Core.canonicalStringify({ b: 1, a: { d: 2, c: 3 } }));
ok('порядок ключей не влияет на результат',
  Core.canonicalStringify({ a: 1, b: 2 }) === Core.canonicalStringify({ b: 2, a: 1 }));
const sha = await Core.sha256Hex('abc');
ok('SHA-256("abc")', sha === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', sha);

console.log('\n[2] Версии');
ok('1.2.0 новее 1.1.9', Core.isNewer('1.2.0', '1.1.9'));
ok('1.1.0 не новее 1.1.0', !Core.isNewer('1.1.0', '1.1.0'));
ok('релиз новее pre-release', Core.compareVersions('1.1.0', '1.1.0-beta.1') > 0);
ok('битая версия не валидна', !Core.parseVersion('oops'));

console.log('\n[3] Подпись ECDSA P-256 и целостность');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const pubB64 = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const source = readJson('ota/source.json');
const signed = await Core.signPayload(source, privateKey);
ok('подпись создана', !!signed.integrity.signature);
const v = await Core.verifyPayload(signed, pubB64);
ok('хэш совпал', v.hashOk);
ok('подпись действительна', v.signature === 'valid', v.detail);
const tampered = JSON.parse(JSON.stringify(signed));
tampered.settings.capture = { limitPerMinute: 999999 };
const tv = await Core.verifyPayload(tampered, pubB64);
ok('подмена обнаружена по хэшу', !tv.hashOk);
ok('подмена обнаружена по подписи', tv.signature === 'invalid');
const vNoKey = await Core.verifyPayload(signed, '');
ok('без ключа подпись «не проверяема»', vNoKey.signature === 'unverifiable');
const unsigned = await Core.signPayload(source, null);
ok('без приватного ключа подписи нет', unsigned.integrity.signature === null);
const uv = await Core.verifyPayload(unsigned, pubB64);
ok('неподписанный документ: хэш есть, подписи нет', uv.hashOk && uv.signature === 'absent');

console.log('\n[4] Валидация и политика безопасности');
const remoteOpts = (integrity) => ({
  extensionVersion: '1.1.0', fromRemote: true,
  requireSignature: false, allowUnsignedCode: false, integrity
});
const good = await Core.validate(signed, remoteOpts(v));
ok('корректный подписанный документ принят', good.ok, good.error);
const badSchema = await Core.validate({ schema: 99, version: '9.9.9' }, { fromRemote: true, integrity: { hashOk: true } });
ok('чужая schema отклонена', !badSchema.ok);
const badVer = await Core.validate({ version: 'нет' }, remoteOpts({ hashOk: true, signature: 'absent' }));
ok('битая версия отклонена', !badVer.ok);
const future = await Core.validate({ version: '2.0.0', minExtension: '9.9.9' }, remoteOpts({ hashOk: true, signature: 'absent' }));
ok('minExtension требует новую сборку', !future.ok && !!future.needsNewBuild);
const noHash = await Core.validate(signed, { fromRemote: true, integrity: { hashOk: false, signature: 'absent' } });
ok('документ без совпавшего хэша отклонён', !noHash.ok);
const strict = await Core.validate(unsigned, { fromRemote: true, requireSignature: true, integrity: uv });
ok('строгий режим требует подпись', !strict.ok);

const withCode = Object.assign({}, source, {
  patch: Object.assign({}, source.patch, { hookCode: '(function(){window.__X=1})();' })
});
const signedCode = await Core.signPayload(withCode, privateKey);
function unsignedWithCode() { return Object.assign({}, withCode); }
const stripped = await Core.validate(unsignedWithCode(), remoteOpts(uv));
ok('неподписанный удалённый hookCode вырезается',
  stripped.ok && !stripped.payload.patch.hookCode, stripped.error || '');
const signedCodeCheck = await Core.validate(signedCode, remoteOpts(await Core.verifyPayload(signedCode, pubB64)));
ok('подписанный hookCode разрешён', signedCodeCheck.ok && !!signedCodeCheck.payload.patch.hookCode, signedCodeCheck.error);
const allowedCode = await Core.validate(unsignedWithCode(), {
  fromRemote: true, integrity: { hashOk: true, signature: 'absent' }, allowUnsignedCode: true
});
ok('явное разрешение политики пускает hookCode', allowedCode.ok && !!allowedCode.payload.patch.hookCode);

console.log('\n[5] Слияние конфигурации и локальные правки');
const applied = { payload: (await Core.validate(signed, { fromRemote: false })).payload, appliedAt: 1, source: 'channel' };
const eff0 = Core.effective({ applied }, '1.1.0');
ok('эффективные настройки содержат дефолты', eff0.settings.capture.limitPerMinute === 400);
ok('подпись метрики из канала применилась', eff0.patch.metrics.attack_damage_avg.label === 'Урон (средний)');
const local = Core.pickLocalPatch({
  settings: { overlay: { title: 'Мой оверлей' } },
  patch: { features: { pause_capture: true } },
  announcement: { level: 'warn', text: 'Тест' },
  note: 'быстрая правка'
});
ok('локальная правка «разреженная»', Object.keys(local.settings).length === 1, JSON.stringify(local.settings));
const eff1 = Core.effective({ applied, localPatch: local }, '1.1.0');
ok('локальная правка не затирает канал', eff1.settings.capture.limitPerMinute === 400 &&
  eff1.settings.overlay.title === 'Мой оверлей');
ok('локальная правка имеет приоритет', eff1.source === 'local' && eff1.announcement.text === 'Тест');
ok('локальный hookCode доверенный', !!Core.pickLocalPatch({ patch: { hookCode: 'var a=1;' } }).patch.hookCode);
ok('пустой hookCode отключает удалённый код', !Core.effective({
  applied: { payload: { version: '1.1.0', settings: {}, patch: { hookCode: 'var x=1;' } } },
  localPatch: Core.pickLocalPatch({ patch: { hookCode: '' } })
}, '1.1.0').patch.hookCode);
ok('опасный CSS отфильтрован', !Core.pickLocalPatch({ patch: { overlayCss: '</style><script>x</script>' } }).patch.overlayCss);
ok('плохая регулярка не ломает настройки',
  Core.pickSettings({ capture: { relevantPattern: '([unclosed' } }).capture.relevantPattern ===
  Core.DEFAULT_SETTINGS.capture.relevantPattern);

console.log('\n[6] Файлы проекта');
const manifest = readJson('manifest.json');
ok('manifest v1.1.0', manifest.version === '1.1.0');
ok('есть permission alarms', (manifest.permissions || []).includes('alarms'));
const refs = new Set([
  manifest.background.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => c.js || []),
  ...(manifest.web_accessible_resources || []).flatMap((r) => r.resources || []),
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action || {}).default_icon || {}),
  manifest.action.default_popup,
  (manifest.options_ui || {}).page
].filter(Boolean));
for (const f of refs) ok(' manifest → ' + f, fs.existsSync(root(f)));

const htmlFiles = ['popup.html', 'options.html', 'ota.html'];
for (const h of htmlFiles) {
  const text = fs.readFileSync(root(h), 'utf8');
  const links = [...text.matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|chrome-extension:)/.test(u));
  for (const l of links) ok(' ' + h + ' → ' + l, fs.existsSync(root(l)));
  ok(' ' + h + ' без inline-скриптов', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(text));
}

const jsFiles = fs.readdirSync(root('.')).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', root(f)], { encoding: 'utf8' });
  ok(' синтаксис ' + f, r.status === 0, (r.stderr || '').split('\n')[0]);
}
for (const f of fs.readdirSync(root('tools')).filter((x) => x.endsWith('.mjs'))) {
  const r = spawnSync(process.execPath, ['--check', root('tools', f)], { encoding: 'utf8' });
  ok(' синтаксис tools/' + f, r.status === 0, (r.stderr || '').split('\n')[0]);
}

console.log('\n[7] Свежесть собранного канала');
if (fs.existsSync(root('ota/update.json'))) {
  const built = readJson('ota/update.json');
  const bv = await Core.verifyPayload(built, pubB64);
  ok('хеш update.json совпадает', bv.hashOk);
  ok('версия канала совпадает с source.json', built.version === source.version);
  ok('integrity на месте', !!built.integrity && typeof built.integrity.sha256 === 'string');
} else {
  console.log('  ! ota/update.json ещё не собран (node tools/build-ota.mjs)');
}

console.log('\nРезультат: ' + passed + ' проверок пройдено, ' + failed + ' провалено\n');
process.exit(failed ? 1 : 0);
