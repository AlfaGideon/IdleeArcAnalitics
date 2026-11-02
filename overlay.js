/*
 * IdleArc Analyst — внутриигровой оверлей.
 * Плавающая кнопка + панель поверх Flutter-канваса.
 */
(function () {
  'use strict';
  if (window.__IA_OVERLAY) return;
  window.__IA_OVERLAY = true;

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? {} : (r || {}))); }
    catch (e) { res({}); }
  });

  const IAS = window.IAS; // ядро подключено перед этим скриптом в манифесте
  let ui = null, panel = null, open = false, snapshots = [], cfg = null;
  let ota = null;                 // эффективная OTA-конфигурация
  let needReload = false;         // поменялся код перехватчика
  let updateHint = null;          // баннер «доступно обновление»
  let pollTimer = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const css = `
  .ia-fab{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:44px;height:44px;border-radius:14px;
    background:linear-gradient(140deg,#8b5cf6,#5b32e8);box-shadow:0 6px 22px #0009,0 0 0 1px #ffffff1a;
    display:grid;place-items:center;font-size:20px;color:#fff;cursor:pointer;user-select:none;
    transition:transform .15s, box-shadow .15s;font-family:system-ui,sans-serif}
  .ia-fab:hover{transform:translateY(-2px);box-shadow:0 10px 26px #000b,0 0 0 1px #ffffff26}
  .ia-fab .ia-badge{position:absolute;top:-5px;right:-5px;background:#34d399;color:#062;border-radius:99px;
    font-size:9px;font-weight:700;padding:1px 5px;border:2px solid #0e1017}
  .ia-panel{position:fixed;right:16px;bottom:70px;z-index:2147483000;width:330px;max-height:min(74vh,620px);
    overflow:auto;background:#12141df2;backdrop-filter:blur(14px);border:1px solid #2b3145;border-radius:16px;
    box-shadow:0 18px 50px #000c;color:#e8eaf2;font:12.5px/1.45 ui-sans-serif,system-ui,sans-serif;
    padding:12px;display:none}
  .ia-panel.ia-on{display:block}
  .ia-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .ia-h .ia-t{font-weight:650;font-size:13px}
  .ia-h .ia-x{margin-left:auto;cursor:pointer;color:#98a0b8;font-size:15px;padding:0 3px}
  .ia-h .ia-x:hover{color:#fff}
  .ia-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
  .ia-st{background:#1b1f2d;border:1px solid #272c3d;border-radius:10px;padding:7px 9px}
  .ia-st .ia-l{font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:#98a0b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ia-st .ia-v{font-size:14.5px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:1px}
  .ia-st .ia-d{font-size:10px;margin-top:1px}
  .ia-up{color:#34d399}.ia-dn{color:#f87171}
  .ia-sec{margin-top:11px;padding-top:10px;border-top:1px solid #272c3d}
  .ia-sec h4{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#98a0b8;margin:0 0 6px;font-weight:600}
  .ia-empty{color:#98a0b8;font-size:11.5px;line-height:1.5}
  .ia-btn{background:#232840;border:1px solid #333b54;border-radius:8px;padding:5px 9px;font-size:11.5px;
    cursor:pointer;color:#e8eaf2}
  .ia-btn:hover{background:#2c3350}
  .ia-btn.pri{background:linear-gradient(180deg,#8360ff,#6b46f0);border-color:#7c5cff;color:#fff}
  .ia-row{display:flex;gap:6px;align-items:center}
  .ia-formula{background:#0b0d13;border:1px solid #272c3d;border-radius:8px;padding:7px;font-family:ui-monospace,Menlo,monospace;
    font-size:11.5px;color:#c9d1e8;overflow-x:auto;white-space:nowrap}
  .ia-kv{display:flex;justify-content:space-between;font-size:11px;padding:1px 0}
  .ia-kv span:first-child{color:#98a0b8}
  .ia-kv span:last-child{font-family:ui-monospace,Menlo,monospace}
  .ia-sel{background:#1b1f2d;border:1px solid #272c3d;border-radius:7px;color:#e8eaf2;padding:4px 6px;font-size:11.5px;width:100%}
  .ia-ota-note{background:#7c5cff1f;border:1px solid #7c5cff55;border-radius:9px;padding:7px 9px;
    margin-bottom:9px;font-size:11px;line-height:1.45;color:#d7ccff}
  .ia-ota-note.warn{background:#fbbf2418;border-color:#fbbf2455;color:#f7dd9b}
  .ia-ota-note.bad{background:#f8717118;border-color:#f8717155;color:#f9b4b4}
  .ia-ota-note.ok{background:#34d39918;border-color:#34d39955;color:#a7f3d0}
  .ia-ota-note b{cursor:pointer;text-decoration:underline}
  `;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function ensure() {
    if (ui) return;
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    ui = el('div', 'ia-fab', `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M4 17.5L9.2 12l3.9 3.2L20 6.5" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="4" cy="17.5" r="1.7" fill="#fff"/><circle cx="9.2" cy="12" r="1.7" fill="#fff"/>
      <circle cx="13.1" cy="15.2" r="1.7" fill="#fff"/><circle cx="20" cy="6.5" r="1.7" fill="#fff"/></svg>`);
    ui.title = 'IdleArc Analyst';
    ui.addEventListener('click', toggle);
    (document.body || document.documentElement).appendChild(ui);

    panel = el('div', 'ia-panel');
    (document.body || document.documentElement).appendChild(panel);

    // живое обновление: снимки + OTA-правки (без перезагрузки страницы)
    chrome.runtime.onMessage.addListener((m) => {
      if (!m) return;
      if (m.type === 'ia:snapshot-added') load();
      if (m.type === 'ia:ota-changed' && m.config) { applyOta(m.config); if (open) load(); }
    });
    document.addEventListener('ia:ota-need-reload', () => {
      needReload = true;
      if (open) render();
    });
    schedulePoll();
  }

  function schedulePoll() {
    clearInterval(pollTimer);
    const ms = (ota && ota.settings && ota.settings.overlay && ota.settings.overlay.refreshMs) || 6000;
    pollTimer = setInterval(() => { if (open) load(); }, ms);
  }

  /** Применяет удалённые/локальные правки к внешнему виду оверлея на лету. */
  function applyOta(config) {
    ota = config || null;
    const o = (ota && ota.settings && ota.settings.overlay) || {};
    if (IAS && typeof IAS.applyRemoteConfig === 'function' && ota) {
      try { IAS.applyRemoteConfig(ota.patch); } catch (e) { /* ignore */ }
    }
    if (ui) {
      ui.title = o.title || 'IdleArc Analyst';
      ui.style.display = o.showFab === false ? 'none'
        : (/\/app\b/.test(location.pathname) ? 'grid' : 'none');
    }
    let style = document.getElementById('ia-ota-style');
    const cssText = (ota && ota.patch && ota.patch.overlayCss) || '';
    if (cssText) {
      if (!style) {
        style = document.createElement('style');
        style.id = 'ia-ota-style';
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = cssText;
    } else if (style) {
      style.textContent = '';
    }
    schedulePoll();
    if (open) render();
  }

  function toggle() {
    open = !open;
    panel.classList.toggle('ia-on', open);
    if (open) load();
  }

  async function load() {
    const st = await send({ type: 'ia:state' });
    snapshots = st.snapshots || [];
    updateHint = st.ota || null;
    if (!cfg) {
      const c = await send({ type: 'ia:config' });
      cfg = c && c.ok ? c.config : null;
    }
    if (!ota) {
      const c = await send({ type: 'ia:ota-effective' });
      if (c && c.ok && c.config) applyOta(c.config);
    }
    render();
  }

  function metric(key) { return (IAS && IAS.METRICS[key]) || { label: key.replace(/_/g, ' '), unit: '', icon: '' }; }
  function fm(v, d) { return IAS ? IAS.fmtNum(v, d == null ? 2 : d) : String(v); }

  function render() {
    if (!panel) return;
    const withStats = snapshots.filter((s) => s.stats && Object.keys(s.stats).length);
    const last = withStats[withStats.length - 1];
    const prev = withStats[withStats.length - 2];
    const badge = ui.querySelector('.ia-badge');
    if (badge) badge.textContent = withStats.length;

    const title = (ota && ota.settings && ota.settings.overlay && ota.settings.overlay.title) || 'IdleArc Analyst';
    let html = `<div class="ia-h"><span class="ia-t">${esc(title)}</span>
      <span class="ia-x" title="Закрыть">✕</span></div>`;

    // Сообщение из канала обновлений
    const ann = ota && ota.announcement;
    if (ann && ann.text && (!ota.settings || !ota.settings.overlay || ota.settings.overlay.showAnnouncement !== false)) {
      html += `<div class="ia-ota-note ${ann.level || 'info'}">${esc(ann.text)}</div>`;
    }
    if (needReload) {
      html += `<div class="ia-ota-note warn">Применён новый перехватчик OTA — перезагрузи вкладку игры
        (кнопка «Перезагрузить игру» в центре обновлений).</div>`;
    }
    if (updateHint && updateHint.hasUpdate) {
      html += `<div class="ia-ota-note">Доступно обновление v${esc(updateHint.availableVersion || '')}.
        <b id="ia-ota-open">Открыть центр обновлений</b></div>`;
    }

    if (!last) {
      html += `<div class="ia-empty">Данных пока нет. Расширение слушает ответы игры — они появляются после
        входа в аккаунт и открытия вкладки персонажа. Можно также добавить снимок вручную в попапе расширения.</div>`;
    } else {
      const order = ['attack_damage_avg', 'dps', 'max_hp', 'defense', 'crit_chance', 'crit_damage',
        'attack_speed', 'dodge_chance', 'strength', 'dexterity', 'intelligence', 'level'];
      const keys = order.filter((k) => last.stats[k] != null);
      Object.keys(last.stats).forEach((k) => { if (!keys.includes(k) && keys.length < 12) keys.push(k); });
      html += `<div class="ia-grid">` + keys.slice(0, 12).map((k) => {
        const d = metric(k);
        const v = last.stats[k];
        const p = prev && prev.stats[k];
        const delta = p != null && Math.abs(v - p) > 1e-9
          ? `<div class="ia-d ${v > p ? 'ia-up' : 'ia-dn'}">${v > p ? '+' : ''}${fm(v - p)}</div>` : '';
        return `<div class="ia-st"><div class="ia-l">${esc(d.icon || '')} ${esc(d.label)}</div>
          <div class="ia-v">${fm(v)}${esc(d.unit || '')}</div>${delta}</div>`;
      }).join('') + `</div>`;

      // авто-подбор формулы по индексу шага для выбранной метрики
      html += `<div class="ia-sec"><h4>Формула по наблюдениям</h4>`;
      const mets = availableList(withStats);
      html += `<select class="ia-sel" id="ia-metric">` +
        mets.map((m) => `<option value="${esc(m.key)}">${esc(metric(m.key).label)} (${m.count})</option>`).join('') +
        `</select><div id="ia-fit" style="margin-top:7px"></div></div>`;
    }

    // быстрый калькулятор
    html += `<div class="ia-sec"><h4>Ожидаемый удар</h4><div id="ia-hit" class="ia-empty">нет данных</div></div>`;
    html += `<div class="ia-sec ia-row"><button class="ia-btn pri" id="ia-popup">Открыть анализ</button>
      <button class="ia-btn" id="ia-refresh">Обновить</button>
      <button class="ia-btn" id="ia-ota-btn" title="Центр обновлений">OTA</button></div>`;
    html += `<div class="ia-sec"><div class="ia-kv"><span>версия</span><span>v${esc(
      (ota && ota.version) || (IAS && IAS.VERSION) || '1.1.0')}</span></div></div>`;

    panel.innerHTML = html;

    panel.querySelector('.ia-x').addEventListener('click', toggle);
    const pop = panel.querySelector('#ia-popup');
    if (pop) pop.addEventListener('click', () => send({ type: 'ia:open-popup' }));
    const ref = panel.querySelector('#ia-refresh');
    if (ref) ref.addEventListener('click', load);
    const otaBtn = panel.querySelector('#ia-ota-btn');
    if (otaBtn) otaBtn.addEventListener('click', () => send({ type: 'ia:ota-open' }));
    const otaOpen = panel.querySelector('#ia-ota-open');
    if (otaOpen) otaOpen.addEventListener('click', () => send({ type: 'ia:ota-open' }));

    const sel = panel.querySelector('#ia-metric');
    if (sel && last) {
      const renderFit = () => {
        const target = panel.querySelector('#ia-fit');
        const pts = snapshotSeries(withStats, sel.value, 'index');
        const f = IAS ? IAS.fitModels(pts) : null;
        if (!f || !f.models.length) {
          target.innerHTML = `<div class="ia-empty">нужно ≥2 точки</div>`;
          return;
        }
        const best = f.best;
        const params = Object.entries(best.params).map(([k, v]) =>
          `<div class="ia-kv"><span>${k}</span><span>${fm(v, 6)}</span></div>`).join('');
        target.innerHTML = `<div class="ia-formula">${best.pretty || best.formula}</div>${params}
          <div class="ia-kv" style="margin-top:4px"><span>R²</span><span>${fm(best.r2, 5)}</span></div>`;
      };
      sel.addEventListener('change', renderFit);
      renderFit();
    }

    const hit = panel.querySelector('#ia-hit');
    if (hit && last && IAS) {
      const s = last.stats;
      if (s.attack_damage_avg != null) {
        const r = IAS.expectedHit({
          avg: s.attack_damage_avg, critChance: s.crit_chance, critDamage: s.crit_damage,
          doubleDamageChance: s.double_damage_chance, doubleHitChance: s.double_hit_chance
        });
        hit.className = '';
        hit.innerHTML = `<div class="ia-kv"><span>база</span><span>${fm(s.attack_damage_avg)}</span></div>
          <div class="ia-kv"><span>с критами/двойными</span><span>${fm(r.expected)}</span></div>
          <div class="ia-kv"><span>множитель</span><span>×${fm(r.expected / (s.attack_damage_avg || 1), 3)}</span></div>`;
      }
    }
  }

  function availableList(withStats) {
    const counts = {};
    withStats.forEach((s) => Object.keys(s.stats).forEach((k) => { counts[k] = (counts[k] || 0) + 1; }));
    const PRIORITY = ['attack_damage_avg', 'dps', 'max_hp', 'defense', 'crit_chance', 'crit_damage', 'strength', 'dexterity', 'intelligence'];
    return Object.entries(counts)
      .filter(([, c]) => c >= 2)
      .sort((a, b) => {
        const pa = PRIORITY.indexOf(a[0]), pb = PRIORITY.indexOf(b[0]);
        if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
        return b[1] - a[1];
      })
      .slice(0, 12)
      .map(([key, count]) => ({ key, count }));
  }

  function snapshotSeries(snaps, metricKey, axis) {
    return snaps.map((s, i) => ({ x: axis === 'index' ? i + 1 : s.t, y: s.stats[metricKey] }))
      .filter((p) => p.y != null && isFinite(p.y));
  }

  /* --------- запуск --------- */
  function boot() {
    if (!document.body) return setTimeout(boot, 300);
    ensure();
    // показываем кнопку только на странице приложения
    if (!/\/app\b/.test(location.pathname)) ui.style.display = 'none';
    else ui.style.display = 'grid';
    // подтянуть удалённые правки даже если панель ни разу не открывали
    send({ type: 'ia:ota-effective' }).then((r) => {
      if (r && r.ok && r.config) applyOta(r.config);
    });
    send({ type: 'ia:state' }).then((r) => {
      if (r && r.ota) { updateHint = r.ota; if (open) render(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
