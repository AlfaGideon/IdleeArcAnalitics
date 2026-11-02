/*
 * IdleArc Analyst — ядро аналитики.
 * Обычный (не ES-модуль) скрипт: подключается и в content script, и в popup/options,
 * поэтому экспортирует всё через window.IAS.
 */
(function (global) {
  'use strict';

  const VERSION = '1.1.0';

  /* ------------------------------------------------------------------ *
   * 1. Реестр метрик
   * ------------------------------------------------------------------ */

  const METRICS = {
    // --- Основные боевые ---
    attack_damage_min: { label: 'Урон (мин)', unit: '', group: 'Урон', icon: '' },
    attack_damage_max: { label: 'Урон (макс)', unit: '', group: 'Урон', icon: '' },
    attack_damage_avg: { label: 'Урон (средний)', unit: '', group: 'Урон', icon: '' },
    dmg_per_attack: { label: 'Урон за удар', unit: '', group: 'Урон', icon: '' },
    dps: { label: 'DPS', unit: '', group: 'Урон', icon: '' },
    attack_speed: { label: 'Скорость атаки', unit: '', group: 'Урон', icon: '' },
    crit_chance: { label: 'Шанс крита', unit: '%', group: 'Урон', icon: '' },
    crit_damage: { label: 'Урон крита', unit: '%', group: 'Урон', icon: '' },
    double_hit_chance: { label: 'Двойной удар', unit: '%', group: 'Урон', icon: '' },
    double_damage_chance: { label: 'Двойной урон', unit: '%', group: 'Урон', icon: '' },
    element_damage: { label: 'Стихийный урон', unit: '%', group: 'Урон', icon: '' },
    boss_damage: { label: 'Урон по боссам', unit: '%', group: 'Урон', icon: '' },
    pet_damage: { label: 'Урон питомца', unit: '', group: 'Урон', icon: '' },

    // --- Выживаемость ---
    max_hp: { label: 'Макс. HP', unit: '', group: 'Защита', icon: '' },
    defense: { label: 'Защита', unit: '', group: 'Защита', icon: '' },
    damage_reduction: { label: 'Снижение урона', unit: '%', group: 'Защита', icon: '' },
    dodge_chance: { label: 'Уклонение', unit: '%', group: 'Защита', icon: '' },
    block_chance: { label: 'Блок', unit: '%', group: 'Защита', icon: '' },
    health_regen: { label: 'Реген HP', unit: '', group: 'Защита', icon: '' },
    life_on_hit: { label: 'Лечение за удар', unit: '', group: 'Защита', icon: '' },
    life_on_kill: { label: 'Лечение за убийство', unit: '', group: 'Защита', icon: '' },
    retaliation: { label: 'Возмездие', unit: '', group: 'Защита', icon: '' },

    // --- Характеристики ---
    strength: { label: 'Сила', unit: '', group: 'Статы', icon: '' },
    dexterity: { label: 'Ловкость', unit: '', group: 'Статы', icon: '' },
    intelligence: { label: 'Интеллект', unit: '', group: 'Статы', icon: '' },
    vitality: { label: 'Живучесть', unit: '', group: 'Статы', icon: '' },

    // --- Экономика ---
    gold_gain: { label: 'Золото', unit: '%', group: 'Экономика', icon: '' },
    exp_gain: { label: 'Опыт', unit: '%', group: 'Экономика', icon: '' },
    drop_chance: { label: 'Шанс дропа', unit: '%', group: 'Экономика', icon: '' },
    material_drop: { label: 'Дроп материалов', unit: '%', group: 'Экономика', icon: '' },
    gold: { label: 'Золото (всего)', unit: '', group: 'Экономика', icon: '' },
    xp: { label: 'Опыт', unit: '', group: 'Экономика', icon: '' },
    level: { label: 'Уровень персонажа', unit: '', group: 'Прогресс', icon: '' },
    monster_level: { label: 'Уровень монстра', unit: '', group: 'Прогресс', icon: '' },
    monster_hp: { label: 'HP монстра', unit: '', group: 'Прогресс', icon: '' },
    kills_per_min: { label: 'Убийств/мин', unit: '', group: 'Прогресс', icon: '' }
  };

  /** Синонимы ключей (camelCase API, snake_case, отображаемые имена, русский). */
  const KEY_SYNONYMS = {
    attackdamage: 'attack_damage',
    attack_damage: 'attack_damage',
    physicaldamage: 'attack_damage',
    physical_damage: 'attack_damage',
    dmgperattack: 'dmg_per_attack',
    dmg_per_attack: 'dmg_per_attack',
    maxhealth: 'max_hp',
    max_hp: 'max_hp',
    maxhp: 'max_hp',
    hp: 'max_hp',
    health: 'max_hp',
    critchance: 'crit_chance',
    crit_chance: 'crit_chance',
    criticalchance: 'crit_chance',
    critdamage: 'crit_damage',
    crit_damage: 'crit_damage',
    criticaldamage: 'crit_damage',
    doublehitchance: 'double_hit_chance',
    double_hit_chance: 'double_hit_chance',
    doubledamagechance: 'double_damage_chance',
    double_damage_chance: 'double_damage_chance',
    defense: 'defense',
    defence: 'defense',
    armor: 'defense',
    armour: 'defense',
    attackpower: 'attack_damage',
    dodgechance: 'dodge_chance',
    dodge_chance: 'dodge_chance',
    dodge: 'dodge_chance',
    blockchance: 'block_chance',
    block_chance: 'block_chance',
    attack_speed: 'attack_speed',
    attackspeed: 'attack_speed',
    damagereduction: 'damage_reduction',
    damage_reduction: 'damage_reduction',
    healthregen: 'health_regen',
    health_regen: 'health_regen',
    hpregeneration: 'health_regen',
    lifeonhit: 'life_on_hit',
    life_on_hit: 'life_on_hit',
    lifeonkdeath: 'life_on_kill',
    lifeonkilled: 'life_on_kill',
    life_on_kill: 'life_on_kill',
    retaliation: 'retaliation',
    strength: 'strength',
    dexterity: 'dexterity',
    intelligence: 'intelligence',
    vitality: 'vitality',
    goldgainpercent: 'gold_gain',
    gold_gain: 'gold_gain',
    goldgain: 'gold_gain',
    expgainpercent: 'exp_gain',
    exp_gain: 'exp_gain',
    expgain: 'exp_gain',
    dropbonus: 'drop_chance',
    drop_chance: 'drop_chance',
    itemdropchance: 'drop_chance',
    materialdropchance: 'material_drop',
    petdamagepercent: 'pet_damage',
    pet_damage: 'pet_damage',
    petdamage: 'pet_damage',
    elementaldamage: 'element_damage',
    elemental_damage: 'element_damage',
    bossdamage: 'boss_damage',
    boss_damage: 'boss_damage',
    dps: 'dps',
    player_dps: 'dps',
    killspermin: 'kills_per_min',
    kills_per_min: 'kills_per_min',
    gold: 'gold',
    goldamount: 'gold',
    xp: 'xp',
    exp: 'xp',
    experience: 'xp',
    level: 'level',
    player_level: 'level',
    playerlevel: 'level',
    monsterlevel: 'monster_level',
    monster_level: 'monster_level',
    monsterhp: 'monster_hp',
    monster_hp: 'monster_hp',
    hp_actual: 'monster_hp'
  };

  /** Подписи для ручного ввода — по ним распознаём метрику в тексте интерфейса. */
  const LABEL_HINTS = [
    [/\battack\s*damage\b|урон/i, 'attack_damage_avg'],
    [/\bcrit(ical)?\s*chance\b|шанс\s*крит/i, 'crit_chance'],
    [/\bcrit(ical)?\s*damage\b|урон\s*крит/i, 'crit_damage'],
    [/\bdouble\s*hit\b|двойн\w*\s*удар/i, 'double_hit_chance'],
    [/\bdouble\s*damage\b|двойн\w*\s*урон/i, 'double_damage_chance'],
    [/\bmax(imum)?\s*hp\b|макс\w*\s*(hp|здоров)/i, 'max_hp'],
    [/\bdefen[cs]e\b|защит/i, 'defense'],
    [/\bdodge\b|уклонен/i, 'dodge_chance'],
    [/\bblock\b|блок/i, 'block_chance'],
    [/\battack\s*speed\b|скорость\s*атаки/i, 'attack_speed'],
    [/\bstrength\b|сила/i, 'strength'],
    [/\bdexterity\b|ловкость/i, 'dexterity'],
    [/\bintelligence\b|интеллект/i, 'intelligence'],
    [/\bgold\b|золот/i, 'gold_gain'],
    [/\bexp(erience)?\b|опыт/i, 'exp_gain'],
    [/\bdps\b/i, 'dps']
  ];

  /* ------------------------------------------------------------------ *
   * 2. Парсинг чисел
   * ------------------------------------------------------------------ */

  /** «1.23K», «1,23 K», «4.5M», «2 млрд», «12%», «1 234» → number */
  function parseNum(input) {
    if (input == null) return null;
    if (typeof input === 'number') return isFinite(input) ? input : null;
    if (typeof input === 'boolean') return null;
    let s = String(input).trim();
    if (!s) return null;
    s = s.replace(/%/g, '').replace(/\u00a0/g, ' ').replace(/[\s_+]/g, '');
    // десятичная запятая: «1,23» -> «1.23» (но «1,234,567» — разделители тысяч)
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');

    const m = s.match(/^(-?\d*\.?\d+(?:e[+-]?\d+)?)([a-zA-Zа-яА-Я]*)$/);
    if (!m) return null;
    const base = parseFloat(m[1]);
    if (!isFinite(base)) return null;
    const suf = (m[2] || '').toLowerCase();
    const MULT = {
      '': 1, k: 1e3, тыс: 1e3, thousand: 1e3,
      m: 1e6, мм: 1e6, млн: 1e6, million: 1e6,
      b: 1e9, млрд: 1e9, billion: 1e9,
      t: 1e12, трлн: 1e12, trillion: 1e12,
      qa: 1e15, q: 1e15, квдр: 1e15, quadrillion: 1e15,
      qi: 1e18, quintillion: 1e18,
      s: 1e21, sextillion: 1e21,
      sp: 1e24, septillion: 1e24,
      oc: 1e27, octillion: 1e27,
      no: 1e30, nonillion: 1e30,
      dc: 1e33, decillion: 1e33
    };
    if (suf && !(suf in MULT)) return base;
    return base * (MULT[suf] || 1);
  }

  /** Красивый вывод числа: 1234 → 1.23K, 0.05 → 5%. */
  function fmtNum(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    const d = digits == null ? 2 : digits;
    if (a >= 1e15) return trimZeros((v / 1e15).toFixed(d)) + 'Qa';
    if (a >= 1e12) return trimZeros((v / 1e12).toFixed(d)) + 'T';
    if (a >= 1e9) return trimZeros((v / 1e9).toFixed(d)) + 'B';
    if (a >= 1e6) return trimZeros((v / 1e6).toFixed(d)) + 'M';
    if (a >= 1e4) return trimZeros((v / 1e3).toFixed(d)) + 'K';
    if (a >= 100) return String(Math.round(v));
    if (a >= 1) return trimZeros(v.toFixed(d));
    return trimZeros(v.toPrecision(4));
  }
  function trimZeros(s) {
    return String(s).replace(/\.?0+$/, (m) => (m.indexOf('.') === 0 ? '' : m));
  }
  function fmtPct(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    return fmtNum(v, digits == null ? 2 : digits) + '%';
  }

  function canonKey(key) {
    if (!key) return null;
    const norm = String(key).toLowerCase().replace(/[^a-z0-9а-я_]/gi, '');
    return KEY_SYNONYMS[norm] || null;
  }

  /**
   * Достаёт известные метрики из произвольного JSON-ответа игры.
   * Понимает как плоские объекты, так и структуру {combatStats:{...}, bonusStats:{...}}.
   */
  function normalizeStats(root) {
    const out = {};
    const seen = new Set();

    function feed(name, value) {
      const mk = canonKey(name);
      if (!mk) return;
      const n = parseNum(value);
      if (n == null) return;
      // attack_damage может прийти одним числом или парой min/max — см. ниже
      if (mk === 'attack_damage') {
        if (!('attack_damage_avg' in out)) out.attack_damage_avg = n;
        return;
      }
      if (!(mk in out)) out[mk] = n;
    }

    function visit(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 5 || seen.has(obj)) return;
      seen.add(obj);
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          // {min, max} — диапазон урона
          if ((k === 'attackDamage' || k === 'attack_damage' || k === 'physicalDamage') &&
              (v.min != null || v.max != null)) {
            const mn = parseNum(v.min), mx = parseNum(v.max);
            if (mn != null) out.attack_damage_min = mn;
            if (mx != null) out.attack_damage_max = mx;
            continue;
          }
          // {value: N} / {current: N} / {total: N}
          if ((v.value != null || v.current != null || v.total != null) && !Array.isArray(v)) {
            const inner = v.value != null ? v.value : (v.current != null ? v.current : v.total);
            feed(k, inner);
          }
          visit(v, depth + 1);
        } else if (typeof v === 'number' || typeof v === 'string') {
          feed(k, v);
        }
      }
    }
    visit(root, 0);

    if (out.attack_damage_min != null && out.attack_damage_max != null) {
      out.attack_damage_avg = (out.attack_damage_min + out.attack_damage_max) / 2;
    } else if (out.attack_damage_avg == null && out.dmg_per_attack != null) {
      out.attack_damage_avg = out.dmg_per_attack;
    }
    return out;
  }

  function inferMetric(text) {
    if (!text) return null;
    for (const [re, metric] of LABEL_HINTS) if (re.test(text)) return metric;
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 2b. Горячие правки из OTA-канала.
   * Позволяет менять подписи метрик, синонимы ключей API и подсказки
   * без переустановки расширения. Вызывается в SW, попапе и контент-скрипте.
   * ------------------------------------------------------------------ */
  // Базовые значения нужны, чтобы правки были обратимыми (откат OTA) и чтобы
  // повторные вызовы не копили синонимы/регулярки.
  const BASE_METRICS = JSON.parse(JSON.stringify(METRICS));
  const BASE_SYNONYMS = Object.assign({}, KEY_SYNONYMS);
  const BASE_LABEL_HINTS = LABEL_HINTS.slice();

  function applyRemoteConfig(patch) {
    if (!patch || typeof patch !== 'object') return false;
    // stats.js могут внедрить повторно (резервный механизм Android) —
    // сохраняем правки на window, чтобы они не потерялись при переопределении IAS.
    global.__IA_REMOTE_PATCH__ = patch;
    for (const k of Object.keys(METRICS)) if (!(k in BASE_METRICS)) delete METRICS[k];
    for (const k of Object.keys(BASE_METRICS)) METRICS[k] = Object.assign({}, BASE_METRICS[k]);
    for (const k of Object.keys(KEY_SYNONYMS)) if (!(k in BASE_SYNONYMS)) delete KEY_SYNONYMS[k];
    Object.assign(KEY_SYNONYMS, BASE_SYNONYMS);
    LABEL_HINTS.length = 0;
    Array.prototype.push.apply(LABEL_HINTS, BASE_LABEL_HINTS);
    if (patch.metrics && typeof patch.metrics === 'object') {
      for (const k of Object.keys(patch.metrics).slice(0, 200)) {
        const v = patch.metrics[k];
        if (!v || typeof v !== 'object' || !/^[a-z0-9_]{1,64}$/.test(k)) continue;
        if (!METRICS[k]) METRICS[k] = { label: k, unit: '', group: 'Прочее', icon: '' };
        for (const f of ['label', 'unit', 'group', 'icon']) {
          if (typeof v[f] === 'string') METRICS[k][f] = v[f];
        }
      }
    }
    if (patch.synonyms && typeof patch.synonyms === 'object') {
      for (const k of Object.keys(patch.synonyms).slice(0, 500)) {
        const norm = String(k).toLowerCase().replace(/[^a-z0-9а-я_]/gi, '');
        const target = patch.synonyms[k];
        if (!norm || typeof target !== 'string' || !/^[a-z0-9_]{1,64}$/.test(target)) continue;
        // цель должна быть известной метрикой или уже известным синонимом
        if (METRICS[target] || KEY_SYNONYMS[target] || target === 'attack_damage') {
          KEY_SYNONYMS[norm] = target;
        }
      }
    }
    if (Array.isArray(patch.labelHints)) {
      for (const h of patch.labelHints.slice(0, 100)) {
        if (!Array.isArray(h) || typeof h[0] !== 'string' || typeof h[1] !== 'string') continue;
        try { LABEL_HINTS.push([new RegExp(h[0], h[2] || 'i'), h[1]]); }
        catch (e) { /* плохой regex игнорируем */ }
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 3. Регрессия
   * ------------------------------------------------------------------ */

  function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

  /** '+5' / '−5' / '+0' — для записи формул. */
  function sgn(v) {
    if (v == null || Math.abs(v) < 1e-12) return '+ 0';
    return (v > 0 ? '+ ' : '− ') + fmtNum(Math.abs(v), 4);
  }

  function ols(xs, ys) {
    const n = xs.length;
    const mx = mean(xs), my = mean(ys);
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    if (sxx === 0) return null;
    const b = sxy / sxx;
    const a = my - b * mx;
    return { a, b };
  }

  function stats2(yhat, ys) {
    const n = ys.length;
    const my = mean(ys);
    let sse = 0, sst = 0;
    for (let i = 0; i < n; i++) { sse += (ys[i] - yhat[i]) ** 2; sst += (ys[i] - my) ** 2; }
    const r2 = sst === 0 ? (sse === 0 ? 1 : 0) : 1 - sse / sst;
    return { sse, sst, r2, n };
  }

  function aicc(sse, n, k) {
    if (n <= k + 1) return Infinity;
    const safe = Math.max(sse, 1e-12);
    return n * Math.log(safe / n) + 2 * k + (2 * k * (k + 1)) / (n - k - 1);
  }

  /**
   * Подбирает набор моделей по точкам [{x, y}].
   * Возвращает {models:[...], best, n}. Каждая модель:
   * {id, name, formula, params, predict(x), r2, rmse, aicc, ok, reason}
   */
  function fitModels(points) {
    const pts = (points || [])
      .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
      .filter((p) => isFinite(p.x) && isFinite(p.y));
    const uniq = new Map();
    for (const p of pts) uniq.set(p.x, p); // при дублях x оставляем последнее значение
    const clean = [...uniq.values()].sort((a, b) => a.x - b.x);
    const n = clean.length;
    const xs = clean.map((p) => p.x);
    const ys = clean.map((p) => p.y);
    const models = [];

    const push = (m) => { if (m) models.push(m); };

    // --- Линейная: y = a + b*x ---
    if (n >= 2) {
      const lin = ols(xs, ys);
      if (lin) {
        const yhat = xs.map((x) => lin.a + lin.b * x);
        const st = stats2(yhat, ys);
        push({
          id: 'linear', name: 'Линейная', formula: 'y = a + b·x',
          pretty: `y = ${fmtNum(lin.a, 4)} ${sgn(lin.b)}·x`,
          params: { a: lin.a, b: lin.b }, k: 2,
          predict: (x) => lin.a + lin.b * x,
          deriv: () => lin.b,
          r2: st.r2, sse: st.sse, aicc: aicc(st.sse, n, 2),
          reason: `b = ${fmtNum(lin.b, 4)} за единицу`
        });
      }
    }

    // --- Квадратичная: y = a + b*x + c*x^2 (через нормальные уравнения 3×3) ---
    if (n >= 4 && new Set(xs).size >= 3) {
      const q = polyFit(xs, ys, 2);
      if (q) {
        const yhat = xs.map((x) => q[0] + q[1] * x + q[2] * x * x);
        const st = stats2(yhat, ys);
        push({
          id: 'quadratic', name: 'Квадратичная', formula: 'y = a + b·x + c·x²',
          pretty: `y = ${fmtNum(q[0], 4)} ${sgn(q[1])}·x ${sgn(q[2])}·x²`,
          params: { a: q[0], b: q[1], c: q[2] }, k: 3,
          predict: (x) => q[0] + q[1] * x + q[2] * x * x,
          deriv: (x) => q[1] + 2 * q[2] * x,
          r2: st.r2, sse: st.sse, aicc: aicc(st.sse, n, 3),
          reason: `c = ${fmtNum(q[2], 6)}`
        });
      }
    }

    // --- Степенная: y = A * x^b (лог-лог) ---
    if (n >= 3 && xs.every((x) => x > 0) && ys.every((y) => y > 0)) {
      const lx = xs.map(Math.log), ly = ys.map(Math.log);
      const lin = ols(lx, ly);
      if (lin) {
        const A = Math.exp(lin.a), b = lin.b;
        const yhat = xs.map((x) => A * Math.pow(x, b));
        const st = stats2(yhat, ys);
        push({
          id: 'power', name: 'Степенная', formula: 'y = A · x^b',
          pretty: `y = ${fmtNum(A, 4)} · x^${fmtNum(b, 4)}`,
          params: { A, b }, k: 2,
          predict: (x) => A * Math.pow(x, b),
          deriv: (x) => A * b * Math.pow(x, b - 1),
          r2: st.r2, sse: st.sse, aicc: aicc(st.sse, n, 2),
          reason: `показатель степени b = ${fmtNum(b, 4)}, A = ${fmtNum(A, 4)}`
        });
      }
    }

    // --- Экспоненциальная: y = A * e^(b*x) ---
    if (n >= 3 && ys.every((y) => y > 0)) {
      const ly = ys.map(Math.log);
      const lin = ols(xs, ly);
      if (lin) {
        const A = Math.exp(lin.a), b = lin.b;
        const yhat = xs.map((x) => A * Math.exp(b * x));
        const st = stats2(yhat, ys);
        push({
          id: 'exp', name: 'Экспоненциальная', formula: 'y = A · e^(b·x)',
          pretty: `y = ${fmtNum(A, 4)} · e^(${fmtNum(b, 4)}·x)`,
          params: { A, b }, k: 2,
          predict: (x) => A * Math.exp(b * x),
          deriv: (x) => A * b * Math.exp(b * x),
          r2: st.r2, sse: st.sse, aicc: aicc(st.sse, n, 2),
          reason: `рост ${fmtNum((Math.exp(b) - 1) * 100, 2)}% за шаг`
        });
      }
    }

    // --- Степенная с офсетом: y = A*x^b + C (грубо, через 3 точки) ---
    // Пропускаем: неустойчива на малых выборках, вводит в заблуждение.

    models.forEach((m) => { m.rmse = Math.sqrt(m.sse / Math.max(1, n)); m.n = n; });

    // Выбор лучшей: AICc, но при равных данных предпочитаем более простую модель.
    let best = null;
    for (const m of models) {
      if (!best) { best = m; continue; }
      const better = m.aicc < best.aicc - 1e-9;
      const tieSimpler = Math.abs(m.aicc - best.aicc) <= 1e-9 && m.k < best.k;
      if (better || tieSimpler) best = m;
    }

    // Для двух точек — точное решение степенной зависимости (частый кейс «базовые параметры»).
    let exact = null;
    if (n === 2 && xs[0] > 0 && xs[1] > 0 && ys[0] > 0 && ys[1] > 0 && xs[0] !== xs[1]) {
      const b = Math.log(ys[1] / ys[0]) / Math.log(xs[1] / xs[0]);
      const A = ys[0] / Math.pow(xs[0], b);
      exact = { A, b };
    }

    return { models, best, n, points: clean, exact, enough: n >= 3 };
  }

  /** Решение системы нормальных уравнений для полинома степени deg. */
  function polyFit(xs, ys, deg) {
    const m = deg + 1;
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    const B = new Array(m).fill(0);
    for (let i = 0; i < xs.length; i++) {
      const pw = [1];
      for (let p = 1; p <= 2 * deg; p++) pw.push(pw[p - 1] * xs[i]);
      for (let r = 0; r < m; r++) {
        for (let c = 0; c < m; c++) A[r][c] += pw[r + c];
        B[r] += pw[r] * ys[i];
      }
    }
    return solve(A, B);
  }

  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
      if (Math.abs(M[p][i]) < 1e-12) return null;
      [M[i], M[p]] = [M[p], M[i]];
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = M[r][i] / M[i][i];
        for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  /* ------------------------------------------------------------------ *
   * 4. Ряды из снимков
   * ------------------------------------------------------------------ */

  /**
   * Собирает точки (x, y) для метрики из снимков.
   * xKey: 'index' (порядковый номер) | 'time' | имя метрики-оси (например level)
   */
  function buildSeries(snapshots, metric, xKey) {
    const pts = [];
    (snapshots || []).forEach((s, i) => {
      const y = s.stats ? s.stats[metric] : undefined;
      if (y == null || !isFinite(y)) return;
      let x;
      if (xKey === 'time') x = s.t;
      else if (xKey === 'index') x = i + 1;
      else x = s.stats ? s.stats[xKey] : undefined;
      if (x == null || !isFinite(x)) return;
      pts.push({ x, y, t: s.t });
    });
    return pts;
  }

  /** Метрики, по которым есть данные в снимках. */
  function availableMetrics(snapshots) {
    const counts = {};
    (snapshots || []).forEach((s) => {
      if (!s.stats) return;
      for (const [k, v] of Object.entries(s.stats)) {
        if (v == null || !isFinite(v)) continue;
        counts[k] = (counts[k] || 0) + 1;
      }
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => ({ metric: k, count: c, def: METRICS[k] || { label: k, unit: '' } }));
  }

  /* ------------------------------------------------------------------ *
   * 5. Прикладные калькуляторы
   * ------------------------------------------------------------------ */

  /** Ожидаемый урон за удар с учётом критов/двойных ударов. */
  function expectedHit(input) {
    const avg = num(input.avg) || 0;
    const critChance = (num(input.critChance) || 0) / 100;
    const critDamage = (num(input.critDamage) || 0) / 100; // +X% к урону крита
    const doubleDamage = (num(input.doubleDamageChance) || 0) / 100;
    const doubleHit = (num(input.doubleHitChance) || 0) / 100;
    const critMult = 1 + critChance * critDamage;          // крит добавляет critDamage к базе
    const ddMult = 1 + doubleDamage;                        // каждое срабатывание удваивает удар
    const dhMult = 1 + doubleHit;                           // доп. удар целиком
    return {
      base: avg,
      critMult, ddMult, dhMult,
      expected: avg * critMult * ddMult * dhMult
    };
  }

  /** Стоимость апгрейда по геометрической прогрессии. */
  function upgradeCosts(baseCost, growthRate, fromLevel, toLevel) {
    const rows = [];
    let total = 0;
    for (let lvl = fromLevel; lvl < toLevel; lvl++) {
      const c = baseCost * Math.pow(1 + growthRate, lvl - fromLevel);
      rows.push({ level: lvl + 1, cost: c, cumulative: total + c });
      total += c;
    }
    return { rows, total };
  }

  function num(v) {
    const n = parseNum(v);
    return n == null ? null : n;
  }

  /** Сопоставление строки из конфига с метрикой (для справочника). */
  function metricLabel(metric) {
    const d = METRICS[metric];
    return d ? d.label : metric.replace(/_/g, ' ');
  }

  global.IAS = {
    VERSION,
    METRICS,
    parseNum,
    fmtNum,
    fmtPct,
    num,
    canonKey,
    normalizeStats,
    inferMetric,
    metricLabel,
    fitModels,
    buildSeries,
    availableMetrics,
    expectedHit,
    upgradeCosts,
    polyFit,
    applyRemoteConfig
  };

  // Повторное внедрение stats.js (резервный механизм Android) не должно
  // сбрасывать применённые OTA-правки.
  if (global.__IA_REMOTE_PATCH__) applyRemoteConfig(global.__IA_REMOTE_PATCH__);
})(typeof window !== 'undefined' ? window : globalThis);
