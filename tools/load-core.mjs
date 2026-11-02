/*
 * Загружает ota-core.js / ota-config.js в Node через vm.
 * Гарантирует, что каноническая сериализация, хэш и подпись в инструментах
 * сборки совпадают с реализацией в расширении (один и тот же исходный файл).
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function root(...parts) {
  return path.join(ROOT, ...parts);
}

export function loadCore(files = ['ota-core.js', 'ota-config.js']) {
  const sandbox = {
    console,
    TextEncoder, TextDecoder,
    crypto: webcrypto,
    Buffer,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  for (const f of files) {
    const file = root(f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

export function readJson(rel) {
  return JSON.parse(fs.readFileSync(root(rel), 'utf8'));
}

export function writeJson(rel, value) {
  const file = root(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
