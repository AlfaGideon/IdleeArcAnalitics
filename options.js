/* IdleArc Analyst — страница настроек.
 * Вынесено из options.html: MV3 запрещает inline-скрипты в страницах расширения. */
(function () {
  'use strict';
  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : (r || null))); }
    catch (e) { res(null); }
  });

  document.getElementById('optVer').textContent =
    'v' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '1.1.0');

  const t = document.getElementById('toggle');
  send({ type: 'ia:state' }).then((s) => { if (s) t.classList.toggle('on', !!s.enabled); });
  t.addEventListener('click', async () => {
    const v = !t.classList.contains('on');
    t.classList.toggle('on', v);
    await send({ type: 'ia:set-enabled', value: v });
  });

  document.getElementById('openOta').addEventListener('click', () => {
    send({ type: 'ia:ota-open' });
  });

  async function otaState() {
    const s = await send({ type: 'ia:ota-status' });
    const el = document.getElementById('otaState');
    if (!s || !s.effective) { el.textContent = 'состояние недоступно'; return; }
    const src = { builtin: 'встроенные', channel: 'канал OTA', local: 'локальные правки' };
    el.innerHTML = 'Установлено <code>v' + s.installedVersion + '</code> · правки <code>v' +
      s.effective.version + '</code> (' + (src[s.effective.source] || s.effective.source) + ')' +
      (s.hasUpdate ? ' · <b>доступно обновление v' + s.available.version + '</b>' : ' · обновлений нет');
  }
  otaState();
})();
