/* IdleArc Analyst — логика попапа. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const IAS = window.IAS;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let state = { enabled: true, snapshots: [], selected: [], counters: {}, raw: [], hasConfig: false, configAge: null };
  let config = null;
  let sparkMetric = null;
  let fit = null;
  let pollTimer = null;

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(r || {})); }
    catch (e) { res({}); }
  });

  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, 2200);
  }

  /* ---------------------------------------------------------------- */
  /* Вкладки                                                          */
  /* ---------------------------------------------------------------- */
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('act', t === tab));
    $$('.pane').forEach((p) => p.classList.toggle('act', p.id === 'pane-' + tab.dataset.tab));
    if (tab.dataset.tab === 'ref') renderRef();
    if (tab.dataset.tab === 'formulas') renderFormulas();
  }));

  /* ---------------------------------------------------------------- */
  /* Загрузка состояния                                               */
  /* ---------------------------------------------------------------- */
  async function refresh() {
    const st = await send({ type: 'ia:state' });
    if (st.ok) state = st;
    const ota = state.ota || null;
    $('#ver').textContent = 'v' + (ota && ota.installedVersion ? ota.installedVersion : IAS.VERSION) +
      (ota && ota.source && ota.source !== 'builtin' ? ' · OTA ' + ota.version : '');
    $('#toggle').classList.toggle('on', !!state.enabled);
    $('#dot').className = 'dot ' + (state.enabled ? (state.counters && state.counters.captures ? 'on' : '') : 'off');

    const last = [...(state.snapshots || [])].reverse().find((s) => Object.keys(s.stats || {}).length);
    $('#statusLine').textContent = last
      ? 'данные от ' + new Date(last.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : (state.enabled ? 'ожидание данных из игры' : 'сбор выключен');

    $('#stSnaps').textContent = (state.snapshots || []).length;
    $('#stCaps').textContent = (state.counters && state.counters.captures) || 0;
    $('#stConf').textContent = state.hasConfig ? 'есть' : '—';

    renderOverview();
    renderData();
    renderCalc(true);
    renderOtaBrief(ota);
  }

  /* ---------------------------------------------------------------- */
  /* OTA: баннер, карточка, кнопки                                     */
  /* ---------------------------------------------------------------- */
  function renderOtaBrief(ota) {
    const pill = $('#otaBtn');
    const banner = $('#otaBanner');
    pill.classList.toggle('has', !!(ota && (ota.source !== 'builtin' || ota.hasUpdate)));
    pill.classList.toggle('err', !!(ota && ota.announcement && ota.announcement.level === 'bad'));
    if (!ota) { banner.hidden = true; return; }

    let text = '', cls = '', show = false;
    if (ota.hasUpdate && ota.showBanner !== false) {
      show = true;
      text = 'Доступно обновление v' + (ota.availableVersion || '') + ' — открой центр обновлений.';
    } else if (ota.announcement && ota.announcement.text) {
      show = true;
      text = ota.announcement.text;
      cls = ota.announcement.level === 'warn' ? 'warn' : (ota.announcement.level === 'bad' ? 'bad' : '');
    }
    banner.hidden = !show;
    banner.className = 'ota-banner' + (cls ? ' ' + cls : '');
    $('#otaBannerText').textContent = text;
  }

  async function refreshOtaCard() {
    const s = await send({ type: 'ia:ota-status' });
    if (!s || !s.effective) return;
    $('#otaInstalled').textContent = 'v' + s.installedVersion;
    $('#otaApplied').textContent = s.applied ? ('v' + s.applied.version + ' · ' + s.applied.source) : 'нет (заводские)';
    const src = { builtin: 'встроенные', channel: 'канал OTA', local: 'локальные правки' };
    $('#otaSource').textContent = src[s.effective.source] || s.effective.source;
    $('#otaLast').textContent = s.lastCheckAt
      ? new Date(s.lastCheckAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : 'ещё не проверялся';
    if (s.lastError) $('#otaLast').textContent += ' · ошибка';
  }

  async function applyOtaToCore() {
    const r = await send({ type: 'ia:ota-effective' });
    if (r && r.ok && r.config && typeof IAS.applyRemoteConfig === 'function') {
      IAS.applyRemoteConfig(r.config.patch);
    }
  }

  /* ---------------------------------------------------------------- */
  /* ОБЗОР                                                            */
  /* ---------------------------------------------------------------- */
  const TILE_ORDER = [
    'attack_damage_avg', 'dps', 'max_hp', 'defense', 'crit_chance', 'crit_damage',
    'attack_speed', 'dodge_chance', 'double_hit_chance', 'double_damage_chance',
    'strength', 'dexterity', 'intelligence', 'level', 'gold_gain', 'exp_gain', 'monster_level'
  ];

  function renderOverview() {
    const snaps = state.snapshots || [];
    const withStats = snaps.filter((s) => s.stats && Object.keys(s.stats).length);
    if (!withStats.length) {
      $('#ovEmpty').hidden = false; $('#ovBody').hidden = true;
      return;
    }
    $('#ovEmpty').hidden = true; $('#ovBody').hidden = false;

    const last = withStats[withStats.length - 1];
    const prev = withStats.length > 1 ? withStats[withStats.length - 2] : null;
    $('#ovTime').textContent = new Date(last.t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    const keys = TILE_ORDER.filter((k) => last.stats[k] != null);
    Object.keys(last.stats).forEach((k) => { if (!keys.includes(k) && keys.length < 18) keys.push(k); });

    $('#ovTiles').innerHTML = keys.slice(0, 18).map((k) => {
      const def = IAS.METRICS[k] || { label: k, unit: '', icon: '•' };
      const v = last.stats[k];
      const p = prev && prev.stats[k] != null ? prev.stats[k] : null;
      const d = p != null ? v - p : null;
      const dpct = p != null && p !== 0 ? (100 * (v - p)) / Math.abs(p) : null;
      const delta = d == null || Math.abs(d) < 1e-9 ? '' :
        `<div class="sub ${d > 0 ? 'delta-up' : 'delta-dn'}">${d > 0 ? '+' : ''}${IAS.fmtNum(d, 2)}${dpct != null ? ' (' + (dpct > 0 ? '+' : '') + IAS.fmtNum(dpct, 1) + '%)' : ''}</div>`;
      return `<div class="stat"><div class="lab">${def.icon || ''} ${esc(def.label)}</div>
        <div class="val">${IAS.fmtNum(v, 2)}${def.unit || ''}</div>${delta}</div>`;
    }).join('');

    $('#ovDeltaHint').textContent = prev
      ? 'Δ — разница с предыдущим снимком. Эти изменения и есть материал для поиска формул.'
      : 'Это первый снимок. Сделай изменение в игре — появится второй, и расширение покажет дельты.';

    // чипсы метрик для мини-графика
    const avail = IAS.availableMetrics(withStats);
    if (!sparkMetric || !avail.some((a) => a.metric === sparkMetric)) sparkMetric = avail[0] && avail[0].metric;
    $('#ovChips').innerHTML = avail.slice(0, 10).map((a) =>
      `<button class="chip ${a.metric === sparkMetric ? 'act' : ''}" data-m="${a.metric}">${esc(a.def.label)}</button>`).join('');
    $$('#ovChips .chip').forEach((c) => c.addEventListener('click', () => { sparkMetric = c.dataset.m; renderOverview(); }));
    drawSpark(withStats, sparkMetric);
  }

  function drawSpark(snaps, metric) {
    const svg = $('#ovSpark');
    const def = IAS.METRICS[metric] || { label: metric };
    $('#ovSparkLab').textContent = def.label || '';
    const pts = snaps.map((s, i) => ({ x: i, y: s.stats[metric] })).filter((p) => p.y != null && isFinite(p.y));
    if (pts.length < 2) {
      svg.innerHTML = `<text x="160" y="38" fill="#626a82" font-size="11" text-anchor="middle">нужно ≥2 точек</text>`;
      return;
    }
    const W = 320, H = 70, pad = 6;
    const ys = pts.map((p) => p.y);
    const min = Math.min(...ys), max = Math.max(...ys);
    const X = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, pts.length - 1);
    const Y = (v) => max === min ? H / 2 : H - pad - ((v - min) * (H - 2 * pad)) / (max - min);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    const area = `${d} L${X(pts.length - 1).toFixed(1)},${H - pad} L${X(0).toFixed(1)},${H - pad} Z`;
    svg.innerHTML = `
      <defs><linearGradient id="sparkgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>
      </linearGradient></defs>
      <line class="ax" x1="0" y1="${H - pad}" x2="${W}" y2="${H - pad}"></line>
      <path class="area" d="${area}"></path>
      <path class="line" d="${d}"></path>
      ${pts.map((p, i) => `<circle class="pt" cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.1"/>`).join('')}
      <text x="${pad}" y="10" fill="#98a0b8" font-size="9">${IAS.fmtNum(max, 1)}</text>
      <text x="${pad}" y="${H - 10}" fill="#98a0b8" font-size="9">${IAS.fmtNum(min, 1)}</text>`;
  }

  /* ---------------------------------------------------------------- */
  /* ФОРМУЛЫ                                                          */
  /* ---------------------------------------------------------------- */
  function renderFormulas() {
    const snaps = (state.snapshots || []).filter((s) => s.stats && Object.keys(s.stats).length);
    const avail = IAS.availableMetrics(snaps);

    const mSel = $('#fMetric'); const aSel = $('#fAxis');
    if (!avail.length) {
      mSel.innerHTML = '<option>— нет данных —</option>';
      aSel.innerHTML = '<option>—</option>';
      $('#fResults').innerHTML = `<div class="card empty"><div class="ico">📐</div>
        <p>Сначала нужны наблюдения. Открой игру и измени что-нибудь в персонаже.</p></div>`;
      return;
    }
    const keepM = mSel.value, keepA = aSel.value;
    mSel.innerHTML = avail.map((a) => `<option value="${a.metric}">${esc(a.def.label)} (${a.count})</option>`).join('');
    const axisOpts = [{ v: 'index', l: 'Индекс шага (1,2,3…)' }, { v: 'time', l: 'Время' }]
      .concat(avail.map((a) => ({ v: a.metric, l: 'X = ' + a.def.label })));
    aSel.innerHTML = axisOpts.map((o) => `<option value="${o.v}">${esc(o.l)}</option>`).join('');
    const META = ['level', 'monster_level', 'strength', 'dexterity', 'intelligence'];
    if (keepM && avail.some((a) => a.metric === keepM)) mSel.value = keepM;
    else {
      const dm = avail.find((a) => !META.includes(a.metric) && !/^(gold|xp)$/.test(a.metric));
      if (dm) mSel.value = dm.metric;
    }
    if (keepA && axisOpts.some((o) => o.v === keepA)) aSel.value = keepA;
    else {
      // ось по умолчанию — метрика из «шаговых» (уровень и т.п.), иначе индекс шага
      const axis = avail.find((a) => META.includes(a.metric));
      aSel.value = axis ? axis.metric : 'index';
    }

    const metric = mSel.value, axis = aSel.value;
    const pts = IAS.buildSeries(snaps, metric, axis);
    fit = IAS.fitModels(pts);
    const mDef = IAS.METRICS[metric] || { label: metric };

    const n = fit.n;
    let head = '';
    if (!n) head = `<div class="card empty"><p>Нет точек для этой пары. Выбери другую ось или метрику.</p></div>`;
    else if (!fit.enough) head = `<div class="card"><div class="row"><span class="badge warn">мало данных</span>
        <span class="small muted">${n} ${n === 1 ? 'точка' : 'точки'} — для выбора модели нужно ≥3</span></div></div>`;

    const models = (fit.models || []).map((m) => {
      const isBest = fit.best && m.id === fit.best.id;
      const r2 = m.r2 != null ? m.r2 : 0;
      const badge = r2 >= 0.999 ? '<span class="badge ok">точное совпадение</span>'
        : r2 >= 0.99 ? '<span class="badge ok">очень хорошо</span>'
          : r2 >= 0.95 ? '<span class="badge nt">хорошо</span>'
            : r2 >= 0.8 ? '<span class="badge warn">примерно</span>'
              : '<span class="badge bad">плохо</span>';
      const params = Object.entries(m.params || {})
        .filter(([, v]) => Math.abs(v) >= 1e-9)          // 3e-15 — это шум, а не параметр
        .map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span>${IAS.fmtNum(v, 6)}</span></div>`).join('');
      return `<div class="model ${isBest ? 'best' : ''}">
        <div class="top"><span class="nm">${esc(m.name)}</span>${isBest ? '<span class="badge nt">лучшая</span>' : ''}
          <span class="r2">R² = ${IAS.fmtNum(r2, 5)}</span></div>
        <div class="formula">${esc(m.pretty || m.formula)}</div>
        <div class="tiny muted" style="margin-top:3px">${esc(m.formula)}</div>
        <div style="margin-top:6px">${params}</div>
        <div class="row small" style="margin-top:6px;gap:6px">${badge}
          <span class="muted tiny">${esc(m.reason || '')}</span></div>
      </div>`;
    }).join('');

    const exactNote = fit.exact ? `<div class="card">
        <h3>Точная функция через 2 точки</h3>
        <div class="formula">y = <b>${IAS.fmtNum(fit.exact.A, 6)}</b> · x^<b>${IAS.fmtNum(fit.exact.b, 6)}</b></div>
        <div class="hint">Через две точки проходит бесконечно много кривых; это одна из самых частых в играх
          (степенная). Добавь третью точку, чтобы проверить гипотезу.</div></div>` : '';

    $('#fResults').innerHTML = head + exactNote +
      (models ? `<div class="card"><h3>Модели <span class="spacer"></span><span class="tiny muted">y = ${esc(mDef.label)}, n = ${n}</span></h3>${models}</div>` : '');

    $('#fPredictCard').hidden = !(fit.best && fit.enough);
    updatePredict();
  }

  function updatePredict() {
    if (!fit || !fit.best) return;
    const x = parseFloat($('#fPredictX').value);
    $('#fPredictOut').textContent = isFinite(x) ? IAS.fmtNum(fit.best.predict(x), 3) : '—';
  }

  $('#fMetric').addEventListener('change', renderFormulas);
  $('#fAxis').addEventListener('change', renderFormulas);
  $('#fPredictX').addEventListener('input', updatePredict);

  /* ---------------------------------------------------------------- */
  /* КАЛЬКУЛЯТОР                                                      */
  /* ---------------------------------------------------------------- */
  function calcInputs() {
    return {
      avg: IAS.num($('#cAvg').value) || 0,
      critChance: IAS.num($('#cCrit').value) || 0,
      critDamage: IAS.num($('#cCritDmg').value) || 0,
      doubleDamageChance: IAS.num($('#cDD').value) || 0,
      doubleHitChance: IAS.num($('#cDH').value) || 0,
      attackSpeed: IAS.num($('#cAS').value) || 0
    };
  }

  function renderCalc(fillOnly) {
    const i = calcInputs();
    const r = IAS.expectedHit(i);
    const dps = i.attackSpeed > 0 ? r.expected * i.attackSpeed : r.expected * 1;
    $('#cOutHit').textContent = IAS.fmtNum(r.expected, 1);
    $('#cOutMult').textContent = '×' + IAS.fmtNum(r.expected / (i.avg || 1), 3);
    $('#cOutDps').textContent = IAS.fmtNum(dps, 1) + (i.attackSpeed > 0 ? '' : ' /сек*');

    // маргинальная полезность: +2% к параметру
    const base = r.expected || 1;
    const rows = [];
    const add = (name, fn) => {
      const before = fn(1);
      const after = fn(1.02);
      rows.push({ name, gain: (after - before) / (before || 1) * 100, raw: (after - before) });
    };
    add('Урон', (k) => base * k);
    add('Шанс крита', (k) => IAS.expectedHit({ ...i, critChance: i.critChance * k }).expected);
    add('Урон крита', (k) => IAS.expectedHit({ ...i, critDamage: i.critDamage * k }).expected);
    add('Двойной урон', (k) => IAS.expectedHit({ ...i, doubleDamageChance: i.doubleDamageChance * k }).expected);
    add('Двойной удар', (k) => IAS.expectedHit({ ...i, doubleHitChance: i.doubleHitChance * k }).expected);
    add('Скорость атаки', (k) => IAS.expectedHit({ ...i, attackSpeed: i.attackSpeed * k }).expected * (i.attackSpeed > 0 ? i.attackSpeed * k : k));
    rows.sort((a, b) => b.gain - a.gain);
    const max = rows[0] ? Math.max(...rows.map((r) => Math.abs(r.gain))) || 1 : 1;
    $('#cMargs tbody').innerHTML = rows.map((r, idx) => `<tr>
        <td>${esc(r.name)}${idx === 0 ? ' <span class="badge ok">выгоднее</span>' : ''}</td>
        <td>+${IAS.fmtNum(r.gain, 3)}%<div class="bar" style="margin-top:3px;width:70px;margin-left:auto"><i style="width:${Math.min(100, Math.abs(r.gain) / max * 100).toFixed(0)}%"></i></div></td>
      </tr>`).join('');

    if (fillOnly) {
      const last = [...(state.snapshots || [])].reverse().find((s) => s.stats && s.stats.attack_damage_avg != null);
      if (last && !$('#cAvg').value) fillFrom(last.stats);
    }
    updateUpgradeTable();
  }

  function fillFrom(stats) {
    const set = (id, v, transform) => {
      if (v == null) return;
      $(id).value = transform ? transform(v) : IAS.fmtNum(v, 2).replace(/[KMBTQa]$/, '');
      // для крупных чисел оставляем как есть (парсер поймёт суффикс)
      if (transform) return;
      if (Math.abs(v) >= 1000) $(id).value = IAS.fmtNum(v, 2);
    };
    set('#cAvg', stats.attack_damage_avg);
    set('#cCrit', stats.crit_chance);
    set('#cCritDmg', stats.crit_damage);
    set('#cDD', stats.double_damage_chance);
    set('#cDH', stats.double_hit_chance);
    set('#cAS', stats.attack_speed);
    renderCalc(false);
  }

  $('#cFill').addEventListener('click', () => {
    const last = [...(state.snapshots || [])].reverse().find((s) => s.stats && Object.keys(s.stats).length);
    if (!last) return toast('Снимков пока нет', true);
    fillFrom(last.stats);
    toast('Подставлено из последнего снимка');
  });

  ['#cAvg', '#cCrit', '#cCritDmg', '#cDD', '#cDH', '#cAS'].forEach((id) =>
    $(id).addEventListener('input', () => renderCalc(false)));

  function updateUpgradeTable() {
    const base = IAS.num($('#uBase').value);
    const growth = (IAS.num($('#uGrowth').value) || 0) / 100;
    const count = Math.max(1, Math.min(50, Math.round(IAS.num($('#uCount').value) || 1)));
    if (base == null) { $('#uTable tbody').innerHTML = '<tr><td colspan="3" class="muted small">укажи цену</td></tr>'; return; }
    const { rows, total } = IAS.upgradeCosts(base, growth, 0, count);
    $('#uTable tbody').innerHTML = rows.map((r) =>
      `<tr><td>${r.level}</td><td>${IAS.fmtNum(r.cost, 0)}</td><td>${IAS.fmtNum(r.cumulative, 0)}</td></tr>`).join('') +
      `<tr><td><b>Итого</b></td><td></td><td><b>${IAS.fmtNum(total, 0)}</b></td></tr>`;
  }
  ['#uBase', '#uGrowth', '#uCount'].forEach((id) => $(id).addEventListener('input', updateUpgradeTable));

  $('#uSolve').addEventListener('click', () => {
    const c1 = IAS.num($('#uC1').value), c2 = IAS.num($('#uC2').value), step = IAS.num($('#uStep').value) || 1;
    if (!c1 || !c2 || c1 <= 0 || c2 <= 0) return toast('Нужны две цены', true);
    const g = Math.pow(c2 / c1, 1 / step) - 1;
    $('#uGrowth').value = (g * 100).toFixed(2);
    $('#uBase').value = IAS.fmtNum(c1, 4);
    updateUpgradeTable();
    toast('Рост: ' + (g * 100).toFixed(2) + '% за шаг');
  });

  /* ---------------------------------------------------------------- */
  /* СПРАВОЧНИК                                                       */
  /* ---------------------------------------------------------------- */
  async function loadConfig(force) {
    if (config && !force) return config;
    const r = await send({ type: 'ia:config', force });
    config = r.ok ? r.config : null;
    if (r.ok) $('#rMeta').textContent = 'версия ' + (config.version || '?').split('+')[0] +
      ' · обновлён ' + new Date(r.fetchedAt).toLocaleString('ru-RU');
    else $('#rMeta').textContent = 'не удалось загрузить (нет сети?)';
    return config;
  }

  async function renderRef() {
    const c = await loadConfig(false);
    if (!c) { $('#rBody').innerHTML = '<div class="card empty"><p>Конфиг недоступен.</p></div>'; return; }

    const primary = c.itemization && c.itemization.primary_stats;
    const primaryRows = primary ? Object.entries(primary).map(([stat, effs]) => {
      const eff = Object.entries(effs).map(([k, v]) =>
        `${esc(effLabel(k))}: <b>${IAS.fmtNum(v, 3)}</b>`).join(' · ');
      return `<tr><td>${esc(statRu(stat))}</td><td class="small">${eff}</td></tr>`;
    }).join('') : '';

    const mastery = c.mastery && c.mastery.cost_curve;
    const masteryRows = mastery ? Object.entries(mastery).map(([lvl, cost]) =>
      `<tr><td>${lvl}</td><td>${IAS.fmtNum(cost, 0)}</td></tr>`).join('') : '';

    const stances = c.combat_stances && c.combat_stances.stances
      ? Object.entries(c.combat_stances.stances).map(([k, v]) =>
        `<tr><td>${esc(k)}</td><td class="small">${esc(v.type || '')}</td><td>${v.bonus_pct != null ? '+' + v.bonus_pct + '%' : ''}</td></tr>`).join('')
      : '';

    const tiers = c.itemization && c.itemization.tiers
      ? Object.entries(c.itemization.tiers).map(([k, t]) =>
        `<tr><td>${esc(t.name)}</td><td>${t.max_level}</td><td>${t.affix_slots}</td><td>×${t.multiplier}</td></tr>`).join('')
      : '';

    const monsters = (c.monsters || []).slice(0, 80);
    const monRows = monsters.map((m) =>
      `<tr><td>${esc(m.name)}</td><td>${m.level}</td><td>${IAS.fmtNum(m.base_hp, 0)}</td><td>${IAS.fmtNum(m.base_damage, 0)}</td></tr>`).join('');

    $('#rBody').innerHTML = `
      <div class="card"><h3>Вклад характеристик (из конфига игры)</h3>
        <table><thead><tr><th>Характеристика</th><th>Что даёт 1 очко</th></tr></thead><tbody>${primaryRows}</tbody></table>
        <div class="hint">Это официальные базовые коэффициенты из <span class="mono">/api/config/game</span> — то,
          что игра не показывает в интерфейсе.</div></div>

      <div class="card"><h3>Стойки боя</h3>
        <table><thead><tr><th>Стойка</th><th>Тип</th><th>Бонус</th></tr></thead><tbody>${stances}</tbody></table></div>

      <div class="card"><h3>Уровни мастерства</h3>
        <table><thead><tr><th>Ур.</th><th>Стоимость</th></tr></thead><tbody>${masteryRows}</tbody></table>
        <div class="hint">Стоимость повышения мастерства зоны.</div></div>

      <div class="card"><h3>Редкости предметов</h3>
        <table><thead><tr><th>Тир</th><th>Макс. ур.</th><th>Аффиксы</th><th>Множитель</th></tr></thead><tbody>${tiers}</tbody></table></div>

      <div class="card"><h3>Монстры (первые 80)</h3>
        <table><thead><tr><th>Имя</th><th>Ур.</th><th>HP</th><th>Урон</th></tr></thead><tbody>${monRows}</tbody></table>
        <div class="hint">base_hp / base_damage — «сырые» значения из конфига. Фактические в бою
          масштабируются множителями монстра и зоны.</div></div>`;
  }

  function effLabel(k) {
    const map = {
      physical_damage_percent: 'физ. урон', max_health_percent: 'макс. HP', retaliation_percent: 'возмездие',
      dodge_chance_flat: 'уклонение', pet_damage_percent: 'урон питомца',
      double_damage_chance_flat: 'шанс двойного урона', attack_damage_percent: 'урон'
    };
    return map[k] || k.replace(/_/g, ' ');
  }
  function statRu(k) {
    return ({ strength: 'Сила', dexterity: 'Ловкость', intelligence: 'Интеллект' })[k] || k;
  }
  $('#rRefresh').addEventListener('click', async () => { config = null; await loadConfig(true); renderRef(); toast('Конфиг обновлён'); });

  /* ---------------------------------------------------------------- */
  /* ДАННЫЕ                                                           */
  /* ---------------------------------------------------------------- */
  function renderData() {
    const snaps = state.snapshots || [];
    $('#dList').innerHTML = snaps.length ? [...snaps].reverse().slice(0, 60).map((s, i) => {
      const real = snaps.length - 1 - i;
      const keys = Object.keys(s.stats || {});
      const preview = keys.slice(0, 3).map((k) => `${esc(IAS.metricLabel(k))}: ${IAS.fmtNum(s.stats[k], 2)}`).join(' · ');
      return `<div class="it">
        <span class="mono tiny muted">${new Date(s.t).toLocaleTimeString('ru-RU')}</span>
        <span class="small" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${preview}</span>
        <span class="badge ${s.source === 'manual' ? 'nt' : 'ok'}">${s.source === 'manual' ? 'ручной' : 'авто'}</span>
        <button class="btn sm gh" data-del="${real}" title="Удалить">✕</button>
      </div>`;
    }).join('') : '<div class="empty small">пусто</div>';
    $$('#dList [data-del]').forEach((b) => b.addEventListener('click', async () => {
      await send({ type: 'ia:delete-snapshot', index: Number(b.dataset.del) });
      refresh();
    }));

    const raw = state.raw || [];
    $('#dRaw').innerHTML = raw.length ? [...raw].reverse().map((r) => `
      <details class="raw"><summary><span class="badge nt">${esc(r.method || 'GET')}</span>
        <span class="mono tiny">${esc(r.path || '')}</span>
        <span class="spacer" style="flex:1"></span>
        <span class="tiny muted">${new Date(r.at).toLocaleTimeString('ru-RU')}</span></summary>
        <pre>${esc(JSON.stringify(r.body, null, 1))}</pre></details>`).join('')
      : '<div class="empty small">пока ничего не перехвачено</div>';
  }

  // ручной ввод
  function manualRow(metric, value) {
    const def = IAS.METRICS[metric] || { label: metric };
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label>${esc(def.label)}</label>
      <div class="row"><input type="text" inputmode="decimal" data-metric="${esc(metric)}" placeholder="значение" value="${value != null ? esc(IAS.fmtNum(value, 3)) : ''}">
      <button class="btn sm gh" title="Убрать">✕</button></div>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    $('#mFields').appendChild(row);
  }

  $('#mAddField').addEventListener('click', () => {
    const m = $('#mMetric').value;
    if (m) manualRow(m);
  });
  $('#mSave').addEventListener('click', async () => {
    const stats = {};
    $$('#mFields input[data-metric]').forEach((inp) => {
      const n = IAS.parseNum(inp.value);
      if (n != null) stats[inp.dataset.metric] = n;
    });
    if (!Object.keys(stats).length) return toast('Заполни хотя бы одно поле', true);
    const r = await send({ type: 'ia:add-snapshot', stats, source: 'manual' });
    if (r.ok) { toast('Снимок сохранён'); $$('#mFields input').forEach((i) => { i.value = ''; }); refresh(); }
    else toast('Не удалось сохранить', true);
  });

  $('#dExport').addEventListener('click', async () => {
    const r = await send({ type: 'ia:export' });
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'idlearc-analyst-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    toast('Экспортировано');
  });
  $('#dImport').addEventListener('click', () => $('#dFile').click());
  $('#dFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const r = await send({ type: 'ia:import', data });
      toast('Добавлено снимков: ' + (r.added || 0));
      refresh();
    } catch (err) { toast('Некорректный файл', true); }
  });
  $('#dClear').addEventListener('click', async () => {
    if (!confirm('Удалить все снимки?')) return;
    await send({ type: 'ia:clear' });
    refresh();
    toast('Очищено');
  });

  /* ---------------------------------------------------------------- */
  /* Переключатель                                                    */
  /* ---------------------------------------------------------------- */
  $('#toggle').addEventListener('click', async () => {
    const v = !state.enabled;
    await send({ type: 'ia:set-enabled', value: v });
    refresh();
  });

  /* --------------------------- OTA -------------------------------- */
  const openOta = () => send({ type: 'ia:ota-open' });
  $('#otaBtn').addEventListener('click', openOta);
  $('#otaBannerBtn').addEventListener('click', openOta);
  $('#otaOpenFromCard').addEventListener('click', openOta);
  $('#otaCheck').addEventListener('click', async () => {
    const btn = $('#otaCheck');
    btn.textContent = '…';
    btn.disabled = true;
    const r = await send({ type: 'ia:ota-check' });
    btn.textContent = 'Проверить';
    btn.disabled = false;
    toast(r && r.ok
      ? (r.updated ? 'Обновление v' + r.version + ' применено' : 'Канал актуален')
      : ('Ошибка: ' + ((r && r.error) || 'нет ответа')), !(r && r.ok));
    await applyOtaToCore();
    await refresh();
    await refreshOtaCard();
  });

  /* ---------------------------------------------------------------- */
  /* Инициализация                                                    */
  /* ---------------------------------------------------------------- */
  (async function init() {
    await applyOtaToCore();   // подписи и синонимы метрик из OTA-канала

    // селекты для ручного ввода
    const mSel = $('#mMetric');
    mSel.innerHTML = Object.entries(IAS.METRICS)
      .map(([k, d]) => `<option value="${k}">${esc(d.label)}</option>`).join('');
    mSel.value = 'attack_damage_avg';
    $('#mFields').innerHTML = '';
    manualRow('attack_damage_avg');
    manualRow('level');

    await refresh();
    refreshOtaCard();
    loadConfig(false).catch(() => {});
    // хранилище могут менять другие вкладки — подхватываем без перезагрузки
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && (ch.snapshots || ch.counters || ch.enabled)) {
          clearTimeout(pollTimer);
          pollTimer = setTimeout(refresh, 250);
        }
      });
    }

    // живые обновления
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'ia:snapshot-added') refresh();
      if (msg.type === 'ia:ota-changed') {
        if (msg.config && typeof IAS.applyRemoteConfig === 'function') IAS.applyRemoteConfig(msg.config.patch);
        refresh();
        refreshOtaCard();
      }
    });
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5000);
  })();
})();
