/*
 * IdleArc Analyst — настройки канала OTA «по умолчанию».
 * Значения можно переопределить в центре обновлений без пересборки расширения.
 * Подключается и в service worker, и в страницы расширения.
 */
(function (global) {
  'use strict';

  /* Основной канал: обычный JSON-файл в этом же репозитории.
   * raw.githubusercontent.com отдаёт его с открытым CORS, без авторизации.
   * Сгенерирован tools/build-ota.mjs из ota/source.json. */
  const DEFAULT_CHANNEL_URL =
    'https://raw.githubusercontent.com/AlfaGideon/IdleeArcAnalitics/main/ota/update.json';

  global.IAOTAConfig = {
    DEFAULT_CHANNEL_URL: DEFAULT_CHANNEL_URL,
    /* Зеркало на случай, если основной хост недоступен (необязательно). */
    DEFAULT_BACKUP_URL: '',
    /* Таймаут одного запроса, мс. */
    FETCH_TIMEOUT_MS: 12000,

    /* Публичный ключ ECDSA P-256 (SPKI, base64) для проверки подписи канала.
     * Пусто = канал принимается без подписи. Сгенерировать: node tools/keygen.mjs
     * Ключ также можно вставить в центре обновлений — пересборка не нужна. */
    PINNED_PUB_KEY: '',

    DEFAULT_PREFS: {
      channelUrl: DEFAULT_CHANNEL_URL,
      backupUrl: '',
      autoCheck: true,
      checkIntervalMin: 60,
      requireSignature: false,  // true — принимать только подписанные документы
      allowUnsignedCode: false, // true — разрешить удалённый hookCode без подписи
      pubKey: '',               // переопределяет PINNED_PUB_KEY
      applyAutomatically: true  // применять найденное обновление сразу
    },

    DEFAULT_PUBLISHER: {
      owner: 'AlfaGideon',
      repo: 'IdleeArcAnalitics',
      branch: 'main',
      path: 'ota/update.json',
      token: '',
      privateKeyPem: ''
    },

    HISTORY_LIMIT: 6,
    LOG_LIMIT: 60
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
