#!/usr/bin/env node
/*
 * Собирает ota/update.json из ota/source.json:
 *   - проверяет структуру документа;
 *   - считает SHA-256 канонического JSON;
 *   - подписывает ECDSA P-256, если доступен приватный ключ.
 *
 * Ключ берётся из (по приоритету): --key <файл>, переменной OTA_PRIVATE_KEY,
 * файла ota/private.pem. Без ключа документ остаётся неподписанным — расширение
 * его примет, но удалённый hookCode будет отключён политикой безопасности.
 *
 * Примеры:
 *   node tools/build-ota.mjs
 *   node tools/build-ota.mjs --now --version 1.1.1
 *   OTA_PRIVATE_KEY="$(cat ota/private.pem)" node tools/build-ota.mjs
 */
import fs from 'node:fs';
import { root, loadCore, readJson, writeJson } from './load-core.mjs';

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}
const has = (name) => args.includes(name);

const sourceRel = arg('--source', 'ota/source.json');
const outRel = arg('--out', 'ota/update.json');
const now = has('--now');
const versionOverride = arg('--version', null);

const sandbox = loadCore();
const Core = sandbox.IAOTACore;
if (!Core) throw new Error('не удалось загрузить ota-core.js');

const doc = readJson(sourceRel);
doc.schema = 1;
doc.app = 'IdleArc Analyst';
if (versionOverride) doc.version = versionOverride;
if (now || !doc.publishedAt) doc.publishedAt = new Date().toISOString();
if (!doc.minExtension) doc.minExtension = '1.1.0';
if (!Core.parseVersion(doc.version)) throw new Error('нет корректного поля version (x.y.z)');

// Проверяем структуру, но НЕ расширяем настройки до полных значений:
// в канале хранятся только явно заданные поля, чтобы будущие дефолты расширения
// не перезаписывались старым документом.
const checked = await Core.validate(doc, { extensionVersion: '1.1.0', fromRemote: false });
if (!checked.ok) throw new Error('source.json: ' + checked.error);
if (checked.warnings.length) {
  console.warn('Предупреждения:');
  checked.warnings.forEach((w) => console.warn('  • ' + w));
}

let privateKey = '';
const keyFile = arg('--key', null);
if (keyFile) privateKey = fs.readFileSync(root(keyFile), 'utf8');
else if (process.env.OTA_PRIVATE_KEY) privateKey = process.env.OTA_PRIVATE_KEY;
else {
  const defaultKey = root('ota/private.pem');
  if (fs.existsSync(defaultKey)) privateKey = fs.readFileSync(defaultKey, 'utf8');
}

const signed = await Core.signPayload(doc, privateKey || null);
writeJson(outRel, signed);

console.log('✓ Собран ' + outRel);
console.log('  версия      : v' + signed.version + ' (' + (signed.channel || 'stable') + ')');
console.log('  SHA-256     : ' + signed.integrity.sha256);
console.log('  подпись     : ' + (signed.integrity.signature ? 'ECDSA P-256, есть' : 'нет (неподписанный канал)'));
console.log('  размер      : ' + fs.statSync(root(outRel)).size + ' байт');
if (!signed.integrity.signature) {
  console.log('  Подсказка   : node tools/keygen.mjs --patch-config, затем повтори сборку с ключом.');
}
