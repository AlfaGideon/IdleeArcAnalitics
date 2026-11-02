/* IdleArc Analyst — центр обновлений (ota.html). */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const Core = window.IAOTACore;
  const Conf = window.IAOTAConfig;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let status = null;
  let quickDirty = false;

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : (r || null))); }
    catch (e) { res(null); }
  });

  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, 3000);
  }

  function fmt(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  /* ---------------------------------------------------------------- *
   * Вкладки
   * ---------------------------------------------------------------- */
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('act', t === tab));
    $$('.pane').forEach((p) => p.classList.toggle('act', p.id === 'pane-' + tab.dataset.tab));
  }));

  /* ---------------------------------------------------------------- *
   * Загрузка и отрисовка состояния
   * ---------------------------------------------------------------- */
  async function refresh() {
    const s = await send({ type: 'ia:ota-status' });
    if (!s || !s.effective) {
      $('#statusNote').textContent = 'Не удалось связаться с фоновым скриптом. Закрой и открой страницу ещё раз.';
      return;
    }
    status = s;
    render();
  }

  const SIG = {
    valid: '✓ действительна', absent: 'нет (только SHA-256)',
    invalid: '✗ недействительна', unverifiable: '? не проверена',
    unsupported: '? WebCrypto недоступен'
  };
  const SRC = { builtin: 'встроенные', channel: 'канал OTA', local: 'локальная правка', manual: 'импорт вручную' };

  function render() {
    const e = status.effective;
    $('#sInstalled').textContent = 'v' + status.installedVersion;
    $('#sApplied').textContent = status.applied
      ? 'v' + status.applied.version + ' · ' + (SRC[status.applied.source] || status.applied.source)
      : 'нет (заводские)';
    $('#sSource').textContent = SRC[e.source] || e.source;
    const sig = status.applied && status.applied.signature;
    $('#sSignature').textContent = sig ? (SIG[sig.signature] || sig.signature) : '—';
    $('#sCheck').textContent = fmt(status.lastCheckAt);
    $('#sOk').textContent = fmt(status.lastOkAt);

    const note = $('#statusNote');
    note.className = 'note' + (status.hasUpdate ? ' upd' : (status.lastError ? ' bad' : ''));
    note.innerHTML = 'Канал: <code>' + esc(status.prefs.channelUrl) + '</code><br>' +
      'Активная версия правок <b>v' + esc(e.version) + '</b>' +
      (e.localVersion ? ' (локальная v' + esc(e.localVersion) + ')' : '') +
      '. Хэш SHA-256: ' + (sig ? (sig.hashOk ? 'совпал' : 'НЕ совпал') : 'нет документа') +
      (sig && sig.detail ? ' · ' + esc(sig.detail) : '');

    const err = $('#errorNote');
    err.hidden = !status.lastError;
    err.textContent = status.lastError ? 'Ошибка канала: ' + status.lastError +
      (status.needsNewBuild ? ' — установи свежую сборку расширения (ZIP).' : '') : '';

    const upd = $('#updateNote');
    upd.hidden = !status.hasUpdate;
    if (status.hasUpdate) {
      $('#updVer').textContent = 'v' + status.available.version;
      $('#updChangelog').innerHTML = (status.available.changelog || []).length
        ? (status.available.changelog || []).map((x) => '• ' + esc(x)).join('<br>')
        : 'без описания';
    }

    renderChannel();
    renderPublisher();
    renderLog();
    renderHistory();
    $('#effectiveJson').textContent = JSON.stringify(e, null, 2);
    if (!quickDirty) fillQuick();
    $('#defaultUrlText').textContent = status.defaultChannelUrl;
  }

  function renderChannel() {
    const p = status.prefs;
    $('#cUrl').value = p.channelUrl || '';
    $('#cBackup').value = p.backupUrl || '';
    $('#cInterval').value = p.checkIntervalMin || 60;
    $('#cPubKey').value = p.pubKey || '';
    $('#cPubKey').placeholder = status.pinnedPubKey ? 'используется встроенный ключ' : 'не задан';
    $('#cAuto').checked = !!p.autoCheck;
    $('#cAutoApply').checked = !!p.applyAutomatically;
    $('#cRequireSig').checked = !!p.requireSignature;
    $('#cAllowCode').checked = !!p.allowUnsignedCode;
  }

  function renderPublisher() {
    const p = status.publisher;
    $('#pOwner').value = p.owner || '';
    $('#pRepo').value = p.repo || '';
    $('#pBranch').value = p.branch || '';
    $('#pPath').value = p.path || '';
    $('#tokenState').textContent = p.hasToken
      ? '· сохранён' + (p.hasPrivateKey ? ', ключ сохранён' : '') : '· не задан';
    $('#pToken').placeholder = p.hasToken ? '•••••••• (оставь пустым, чтобы не менять)' : 'github_pat_…';
  }

  function renderLog() {
    const list = $('#logList');
    list.innerHTML = (status.log || []).length
      ? status.log.map((x) => `<div class="it ${esc(x.level)}"><time>${esc(fmt(x.t))}</time><span>${esc(x.text)}</span></div>`).join('')
      : '<div class="it info"><span>журнал пуст</span></div>';
  }

  function renderHistory() {
    const list = $('#historyList');
    list.innerHTML = (status.history || []).length
      ? status.history.map((x) => `<div class="it info"><time>${esc(fmt(x.appliedAt))}</time>` +
          `<span>v${esc(x.version)} · ${esc(SRC[x.source] || x.source)}</span></div>`).join('')
      : '<div class="it info"><span>ещё нет истории — откат станет доступен после первого обновления</span></div>';
  }

  /* ---------------------------------------------------------------- *
   * Быстрые правки
   * ---------------------------------------------------------------- */
  function fillQuick() {
    const e = status.effective;
    const s = e.settings;
    $('#qTitle').value = s.overlay.title || '';
    $('#qGap').value = s.background.snapshotMinGapSec;
    $('#qLimit').value = s.capture.limitPerMinute;
    $('#qTtl').value = s.background.configTtlHours;
    $('#qPaths').value = (s.capture.extraApiPaths || []).join(', ');
    $('#qRefresh').value = s.overlay.refreshMs;
    $('#qRegex').value = s.capture.relevantPattern || '';
    $('#qFab').checked = s.overlay.showFab !== false;
    const f = e.patch.features || {};
    $('#qPause').checked = !!f.pause_capture;
    $('#qAll').checked = !!f.sample_all;
    $('#qAnnounce').value = (e.announcement && e.announcement.text) || '';
  }
  ['qTitle', 'qGap', 'qLimit', 'qTtl', 'qPaths', 'qRefresh', 'qRegex', 'qAnnounce', 'qFab', 'qPause', 'qAll']
    .forEach((id) => $('#' + id).addEventListener('input', () => { quickDirty = true; }));

  function quickPatch() {
    return {
      note: 'быстрые правки из центра обновлений',
      version: status.effective.otaVersion || status.installedVersion,
      settings: {
        background: {
          snapshotMinGapSec: Number($('#qGap').value),
          configTtlHours: Number($('#qTtl').value)
        },
        capture: {
          limitPerMinute: Number($('#qLimit').value),
          relevantPattern: $('#qRegex').value,
          extraApiPaths: $('#qPaths').value.split(',').map((x) => x.trim()).filter(Boolean)
        },
        overlay: {
          title: $('#qTitle').value,
          showFab: $('#qFab').checked,
          refreshMs: Number($('#qRefresh').value)
        }
      },
      patch: { features: { pause_capture: $('#qPause').checked, sample_all: $('#qAll').checked } },
      announcement: $('#qAnnounce').value.trim()
        ? { level: 'info', text: $('#qAnnounce').value.trim() }
        : null
    };
  }

  $('#btnQuickApply').addEventListener('click', async () => {
    const r = await send({ type: 'ia:ota-local', patch: quickPatch() });
    quickDirty = false;
    toast(r && r.ok ? 'Правки применены мгновенно' : ('Ошибка: ' + ((r && r.error) || 'нет ответа')), !(r && r.ok));
    await refresh();
  });
  $('#btnQuickFill').addEventListener('click', () => { quickDirty = false; fillQuick(); toast('Подставлены текущие значения'); });
  $('#btnQuickReset').addEventListener('click', async () => {
    await send({ type: 'ia:ota-local', patch: null });
    quickDirty = false;
    toast('Локальные правки сброшены');
    await refresh();
  });

  /* ---------------------------------------------------------------- *
   * Общие действия
   * ---------------------------------------------------------------- */
  async function check() {
    const btn = $('#btnCheck');
    btn.disabled = true; btn.textContent = 'Проверяю…';
    const r = await send({ type: 'ia:ota-check' });
    btn.disabled = false; btn.textContent = 'Проверить сейчас';
    if (!r) return toast('Нет ответа от фонового скрипта', true);
    toast(r.ok
      ? (r.updated ? (r.applied ? 'Применено v' + r.version : 'Найдено v' + r.version) : 'Канал актуален')
      : ('Ошибка: ' + (r.error || 'неизвестная')), !r.ok);
    await refresh();
  }
  $('#btnCheck').addEventListener('click', check);
  $('#btnCheck2').addEventListener('click', check);

  $('#btnApply').addEventListener('click', async () => {
    const r = await send({ type: 'ia:ota-apply' });
    toast(r && r.ok ? 'Обновление применено' : ('Ошибка: ' + ((r && r.error) || 'нет ответа')), !(r && r.ok));
    await refresh();
  });
  $('#btnRollback').addEventListener('click', async () => {
    const r = await send({ type: 'ia:ota-rollback' });
    toast(r && r.ok ? 'Откат выполнен' : ((r && r.error) || 'Откат невозможен'), !(r && r.ok));
    await refresh();
  });
  $('#btnFactory').addEventListener('click', async () => {
    if (!confirm('Сбросить применённые обновления и локальные правки к заводским настройкам?')) return;
    await send({ type: 'ia:ota-reset' });
    toast('Сброшено к заводским');
    await refresh();
  });
  $('#btnReload').addEventListener('click', async () => {
    const r = await send({ type: 'ia:ota-reload-tabs' });
    toast('Перезагружено вкладок игры: ' + ((r && r.reloaded) || 0));
  });

  function readFile(input, cb) {
    const f = input.files && input.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => cb(String(rd.result || ''));
    rd.readAsText(f);
    input.value = '';
  }
  $('#btnBundled').addEventListener('click', async () => {
    try {
      const res = await fetch(chrome.runtime.getURL('update.json'), { cache: 'no-store' });
      if (!res.ok) throw new Error('в сборке нет update.json');
      const r = await send({ type: 'ia:ota-import', text: await res.text() });
      toast(r && r.ok ? 'Встроенный канал применён' : ('Ошибка: ' + ((r && r.error) || 'нет ответа')), !(r && r.ok));
    } catch (e) {
      toast('Встроенный канал не найден — собери ZIP через tools/make-zip.mjs', true);
    }
    await refresh();
  });
  $('#btnImportFile').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (ev) => {
    readFile(ev.target, async (text) => {
      const r = await send({ type: 'ia:ota-import', text: text });
      toast(r && r.ok ? 'Файл канала применён' : ('Ошибка: ' + ((r && r.error) || 'нет ответа')), !(r && r.ok));
      await refresh();
    });
  });

  /* ---------------------------------------------------------------- *
   * Редактор JSON
   * ---------------------------------------------------------------- */
  function readDoc() {
    try { return { ok: true, doc: JSON.parse($('#docJson').value) }; }
    catch (e) { return { ok: false, error: 'JSON: ' + e.message }; }
  }
  function result(text, bad) {
    const r = $('#editorResult');
    r.textContent = text;
    r.style.color = bad ? '#f9b4b4' : '#a7f3d0';
  }
  function setDoc(doc) { $('#docJson').value = JSON.stringify(doc, null, 2); }

  $('#btnTemplate').addEventListener('click', () => {
    const base = (status && status.applied && status.applied.version) || status.installedVersion;
    const doc = Core.template(Core.parseVersion(base) ? bump(base) : '1.1.1');
    doc.changelog = ['Описание правки'];
    doc.settings = { overlay: { title: 'IdleArc Analyst' } };
    doc.patch = { metrics: { strength: { label: 'Сила' } } };
    setDoc(doc);
    result('Шаблон создан. Отредактируй version/changelog и нужные поля.', false);
  });

  function bump(v) {
    const p = Core.parseVersion(v) || { nums: [1, 1, 0] };
    return p.nums[0] + '.' + p.nums[1] + '.' + (p.nums[2] + 1);
  }

  $('#btnFromChannel').addEventListener('click', () => {
    const doc = status.appliedDocument || Core.template(bump(status.installedVersion));
    setDoc(doc);
    result('Загружен применённый документ канала (без хэша/подписи — они пересчитаются при публикации).', false);
  });
  $('#btnFormat').addEventListener('click', () => {
    const r = readDoc();
    if (!r.ok) return result(r.error, true);
    setDoc(r.doc); result('Отформатировано', false);
  });
  $('#btnValidate').addEventListener('click', async () => {
    const r = readDoc();
    if (!r.ok) return result(r.error, true);
    const v = await Core.validate(r.doc, {
      extensionVersion: status.installedVersion, fromRemote: false
    });
    if (!v.ok) return result('✗ ' + v.error, true);
    const built = await Core.signPayload(v.payload, null);
    result('✓ Документ корректен.\n' +
      'Версия: ' + v.payload.version + '\n' +
      'SHA-256 (канонический JSON): ' + built.integrity.sha256 + '\n' +
      'Полей settings: ' + Object.keys(v.payload.settings).length +
      ', patch: ' + Object.keys(v.payload.patch).length +
      ((v.warnings || []).length ? '\nПредупреждения: ' + v.warnings.join('; ') : ''), false);
  });
  $('#btnEditorFile').addEventListener('click', () => $('#editorFile').click());
  $('#editorFile').addEventListener('change', (ev) => {
    readFile(ev.target, (text) => { $('#docJson').value = text; result('Файл загружен', false); });
  });

  $('#btnLocal').addEventListener('click', async () => {
    const r = readDoc();
    if (!r.ok) return result(r.error, true);
    const a = await send({ type: 'ia:ota-local', patch: r.doc });
    result(a && a.ok ? '✓ Применено как локальная правка (поверх канала, мгновенно)' :
      ('✗ ' + ((a && a.error) || 'нет ответа')), !(a && a.ok));
    await refresh();
  });
  $('#btnManual').addEventListener('click', async () => {
    const r = readDoc();
    if (!r.ok) return result(r.error, true);
    const a = await send({ type: 'ia:ota-import', text: JSON.stringify(r.doc) });
    result(a && a.ok ? '✓ Документ применён как канал (вручную)' :
      ('✗ ' + ((a && a.error) || 'нет ответа')), !(a && a.ok));
    await refresh();
  });

  async function buildDoc() {
    const r = readDoc();
    if (!r.ok) { result(r.error, true); return null; }
    const b = await send({ type: 'ia:ota-build', document: r.doc });
    if (!b || !b.ok) { result('✗ ' + ((b && b.error) || 'нет ответа'), true); return null; }
    result('✓ Собран update.json v' + b.document.version +
      '\nSHA-256: ' + b.document.integrity.sha256 +
      '\nПодпись: ' + (b.signed ? 'есть' : 'нет (канал без подписи)'), false);
    return b.document;
  }

  $('#btnDownload').addEventListener('click', async () => {
    const doc = await buildDoc();
    if (!doc) return;
    const blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'update.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('update.json скачан');
  });
  $('#btnCopy').addEventListener('click', async () => {
    const doc = await buildDoc();
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
      toast('JSON скопирован в буфер');
    } catch (e) { toast('Не удалось скопировать — используй «Скачать»', true); }
  });
  $('#btnPublishFromEditor').addEventListener('click', async () => {
    const r = readDoc();
    if (!r.ok) return result(r.error, true);
    const a = await send({ type: 'ia:ota-publish', document: r.doc });
    result(a && a.ok ? ('✓ Опубликовано v' + a.version + (a.signed ? ' (подписано)' : '')) :
      ('✗ ' + ((a && a.error) || 'нет ответа')), !(a && a.ok));
    if (a && a.ok) toast('Опубликовано на GitHub');
    await refresh();
  });

  /* ---------------------------------------------------------------- *
   * Настройки канала
   * ---------------------------------------------------------------- */
  function perm(method, arg) {
    return new Promise((resolve) => {
      if (!chrome.permissions || !chrome.permissions[method]) return resolve(false);
      try {
        const p = chrome.permissions[method](arg, (v) => resolve(!!v));
        if (p && typeof p.then === 'function') p.then((v) => resolve(!!v)).catch(() => resolve(false));
      } catch (e) { resolve(false); }
    });
  }

  const BUILTIN_HOST = /^(raw\.githubusercontent\.com|gist\.githubusercontent\.com|api\.github\.com)$|\.github\.io$/;

  async function ensureOrigin(url) {
    if (!url) return true;
    let origin;
    try { origin = new URL(url).origin + '/*'; } catch (e) { return false; }
    const host = new URL(url).hostname;
    if (BUILTIN_HOST.test(host)) return true;
    if (await perm('contains', { origins: [origin] })) return true;
    const ok = await perm('request', { origins: [origin] });
    if (!ok) toast('Нет разрешения на ' + new URL(url).origin + ' — запрос может не пройти', true);
    return ok;
  }

  async function savePrefs() {
    const prefs = {
      channelUrl: $('#cUrl').value.trim(),
      backupUrl: $('#cBackup').value.trim(),
      checkIntervalMin: Number($('#cInterval').value) || 60,
      pubKey: $('#cPubKey').value.trim(),
      autoCheck: $('#cAuto').checked,
      applyAutomatically: $('#cAutoApply').checked,
      requireSignature: $('#cRequireSig').checked,
      allowUnsignedCode: $('#cAllowCode').checked
    };
    // chrome.permissions.request требует жеста пользователя — вызываем сразу в обработчике клика
    await ensureOrigin(prefs.channelUrl);
    await ensureOrigin(prefs.backupUrl);
    const r = await send({ type: 'ia:ota-prefs', prefs: prefs });
    toast(r && r.ok ? 'Настройки канала сохранены' : ('Ошибка: ' + ((r && r.error) || 'нет ответа')), !(r && r.ok));
    await refresh();
  }
  $('#btnSavePrefs').addEventListener('click', savePrefs);
  $('#btnDefaultUrl').addEventListener('click', async () => {
    $('#cUrl').value = status.defaultChannelUrl || Conf.DEFAULT_CHANNEL_URL;
    await savePrefs();
  });

  /* ---------------------------------------------------------------- *
   * Публикация
   * ---------------------------------------------------------------- */
  async function savePublisher(clearSecrets) {
    const p = {
      owner: $('#pOwner').value.trim(),
      repo: $('#pRepo').value.trim(),
      branch: $('#pBranch').value.trim(),
      path: $('#pPath').value.trim()
    };
    if (clearSecrets) { p.token = ''; p.privateKeyPem = ''; }
    else {
      if ($('#pToken').value.trim()) p.token = $('#pToken').value.trim();
      if ($('#pKey').value.trim()) p.privateKeyPem = $('#pKey').value.trim();
    }
    const r = await send({ type: 'ia:ota-publisher', publisher: p });
    if (clearSecrets) { $('#pToken').value = ''; $('#pKey').value = ''; }
    else $('#pToken').value = '';   // не держим токен в поле после сохранения
    return r;
  }
  $('#btnSavePublisher').addEventListener('click', async () => {
    const r = await savePublisher(false);
    toast(r && r.ok ? 'Настройки публикации сохранены' : 'Ошибка сохранения', !(r && r.ok));
    await refresh();
  });
  $('#btnClearToken').addEventListener('click', async () => {
    await savePublisher(true);
    toast('Токен и приватный ключ удалены');
    await refresh();
  });
  $('#btnTestPublisher').addEventListener('click', async () => {
    await savePublisher(false);
    const r = await send({ type: 'ia:ota-test-publisher' });
    toast(r && r.ok ? 'Доступ к репозиторию есть' : ('Ошибка: ' + ((r && r.error) || 'нет ответа')), !(r && r.ok));
    await refresh();
  });
  $('#btnRefreshLog').addEventListener('click', refresh);

  /* ---------------------------------------------------------------- *
   * Живые события
   * ---------------------------------------------------------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && (msg.type === 'ia:ota-changed' || msg.type === 'ia:ota-check')) refresh();
  });

  (async function init() {
    await refresh();
    if (!$('#docJson').value.trim() && status) {
      setDoc(status.appliedDocument || Core.template(bump(status.installedVersion)));
    }
  })();
})();
