#!/usr/bin/env node
/*
 * Генерирует пару ECDSA P-256 для подписи канала OTA.
 *
 *   node tools/keygen.mjs                  — создать ключи и распечатать публичный
 *   node tools/keygen.mjs --patch-config  — сразу вписать публичный ключ в ota-config.js
 *
 * ВАЖНО: ota/private.pem игнорируется Git. Для GitHub Actions положи его
 * содержимое в секрет OTA_PRIVATE_KEY. Для публикации из расширения вставь
 * приватный ключ в поле на вкладке «Публикация».
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { root } from './load-core.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const spkiBase64 = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const privFile = root('ota/private.pem');
const pubFile = root('ota/public.key');
fs.mkdirSync(root('ota'), { recursive: true });
fs.writeFileSync(privFile, privateKey, { mode: 0o600 });
fs.writeFileSync(pubFile, spkiBase64 + '\n');

if (process.argv.includes('--patch-config')) {
  const cfg = root('ota-config.js');
  let text = fs.readFileSync(cfg, 'utf8');
  if (/PINNED_PUB_KEY:\s*'[^']*'/.test(text)) {
    text = text.replace(/PINNED_PUB_KEY:\s*'[^']*'/, "PINNED_PUB_KEY: '" + spkiBase64 + "'");
    fs.writeFileSync(cfg, text, 'utf8');
    console.log('✓ Публичный ключ вписан в ota-config.js');
  } else {
    console.warn('! Не нашёл PINNED_PUB_KEY в ota-config.js — вставь ключ вручную');
  }
}

console.log('\nПубличный ключ (SPKI, base64) — вставь в центр обновлений или ota-config.js:\n');
console.log(spkiBase64);
console.log('\nПриватный ключ сохранён в ota/private.pem (НЕ коммить, файл в .gitignore).');
console.log('GitHub Actions: создай секрет OTA_PRIVATE_KEY со содержимым этого файла.');
console.log('Проверка:       node tools/build-ota.mjs && node tools/test-ota.mjs\n');
