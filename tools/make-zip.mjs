#!/usr/bin/env node
/*
 * Собирает готовый к установке ZIP расширения БЕЗ вложенных папок
 * (критично для Android / Яндекс.Браузера, см. INSTALL-ANDROID.txt).
 *
 *   node tools/make-zip.mjs
 *   node tools/make-zip.mjs --out release/my-build.zip
 *
 * В архив также кладётся копия ota/update.json под именем update.json —
 * это «встроенный канал», который можно применить офлайн кнопкой в центре обновлений.
 */
import fs from 'node:fs';
import path from 'node:path';
import { root } from './load-core.mjs';

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const outRel = outArg >= 0 ? args[outArg + 1] : 'release/idlearc-analyst.zip';

const FILES = [
  'manifest.json',
  'background.js', 'content.js', 'inject.js', 'overlay.js',
  'stats.js',
  'ota-config.js', 'ota-core.js', 'ota-updater.js',
  'popup.html', 'popup.js', 'style.css',
  'options.html', 'options.js',
  'ota.html', 'ota.css', 'ota.js',
  'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png',
  'INSTALL-ANDROID.txt', 'README.md'
];

/* -------- минимальный ZIP (метод store, без внешних зависимостей) -------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
function makeZip(entries) {
  const { time, date } = dosDateTime(new Date());
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* -------- сборка -------- */
const entries = [];
for (const f of FILES) {
  const file = root(f);
  if (!fs.existsSync(file)) throw new Error('нет файла: ' + f);
  entries.push({ name: f, data: fs.readFileSync(file) });
}
const channel = root('ota/update.json');
if (fs.existsSync(channel)) {
  entries.push({ name: 'update.json', data: fs.readFileSync(channel) });
} else {
  console.warn('! ota/update.json не найден — сначала node tools/build-ota.mjs');
}

const out = root(outRel);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, makeZip(entries));
console.log('✓ ' + outRel + ' — ' + entries.length + ' файлов, ' + fs.statSync(out).size + ' байт');
console.log('  Все файлы лежат в корне архива, подпапок нет.');
