/*!
 * weewx-carbonsteel-series — live SVG gauges for WeeWX 5
 * Copyright (c) 2026 Ian Millard and contributors. GPL-3.0-or-later.
 * Uses D3 v7 (ISC licence).
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ config
  // Options come from the page itself (#ss-config), or, for gauges shown
  // inside another skin's page, from the CS folder's config.js (window.CS_CONFIG)
  // plus the host page's own settings (window.CS_EMBED: base_url, theme).
  const CFG = (() => {
    let c = {};
    const el = document.getElementById('ss-config');
    if (el) { try { c = JSON.parse(el.textContent) || {}; } catch (e) { c = {}; } }
    else if (window.CS_CONFIG) c = Object.assign({}, window.CS_CONFIG);
    if (window.CS_EMBED) Object.assign(c, window.CS_EMBED);
    return c;
  })();
  const asList = v => Array.isArray(v) ? v : String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  const asBool = (v, d) => v == null || v === '' ? d : !/^(false|no|n|off|0)$/i.test(String(v).trim());
  // controls = false: the page sits inside another skin (Seasons, Belchertown),
  // which has its own header. No ticker, update counter or face/bezel/units
  // switches; units and theme come from the host skin, not the visitor's
  // choices on the CS page.
  const CONTROLS = asBool(CFG.controls, true);
  const SHOW_SPARKS = asBool(CFG.sparklines, true);   // sparklines + 24 h detail charts
  const SHOW_CALENDAR = asBool(CFG.calendar, true);   // year-at-a-glance panel
  const POLL_MS = Math.max(1, parseFloat(CFG.poll_interval) || 2.5) * 1000;
  const STALE_S = parseFloat(CFG.stale_after) || 120;
  // Data files live next to the page, or under base_url when the page is
  // generated elsewhere (e.g. the Seasons page, which reads the CS folder).
  const BASE = CFG.base_url || '';
  const dataUrl = u => /^(https?:)?\/\//.test(u) || u.startsWith('/') ? u : BASE + u;
  const REALTIME_URL = dataUrl(CFG.realtime_url || 'realtime.json');
  const FACE = ['beige', 'white', 'anthracite', 'carbon', 'auto'].includes(CFG.face) ? CFG.face : 'auto';
  const BEZEL = ['chrome', 'black', 'auto'].includes(CFG.bezel) ? CFG.bezel : 'auto';
  const GAUGE_ORDER = asList(CFG.gauges || 'temp,dew,hum,baro,wind,dir,rose,rain,rainrate,uv,solar,cloudbase');
  const RANGES = {};
  for (const [unit, v] of Object.entries(CFG.ranges || {})) {
    const r = asList(v).map(Number);
    if (r.length === 2 && r.every(Number.isFinite)) RANGES[unit] = r;
  }

  // ------------------------------------------------------------ preferences
  // Visitor preferences, kept in this browser under a 'cs.' prefix. The original
  // SteelSeries gauges use cookies instead, so the two pages never share settings.
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cs.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('cs.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };
  const prefs = { units: CONTROLS ? store.get('units', {}) : {}, obs: store.get('obs', {}), calMetric: store.get('calMetric', null) };

  // A page can fix its theme (theme = light|dark); otherwise the visitor's choice is used.
  // theme = light|dark fixes it; theme = host follows the surrounding skin
  // (Belchertown's data-bs-theme / body.dark), including its own theme switch.
  const HOST_THEME = CFG.theme === 'host';
  const FIXED_THEME = ['light', 'dark'].includes(CFG.theme) ? CFG.theme : null;
  const theme = HOST_THEME ? null : (FIXED_THEME || store.get('theme', null));
  if (theme) document.documentElement.dataset.theme = theme;
  if (FIXED_THEME || HOST_THEME) document.getElementById('theme-btn')?.remove();
  const pageIsDark = () => HOST_THEME
    ? document.documentElement.getAttribute('data-bs-theme') === 'dark' || document.body.classList.contains('dark')
    : getComputedStyle(document.documentElement).colorScheme.includes('dark');
  document.getElementById('theme-btn')?.addEventListener('click', () => {
    const next = pageIsDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    applyLook();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyLook());

  // --------------------------------------------------- face & bezel look
  // 'auto' follows the page theme: light = chrome bezel + beige face,
  // dark = black-metal bezel + carbon fibre face. Visitors can override
  // either from the header menus; their choice is kept in their browser.
  const LOOK = {
    face: {
      label: 'Gauge face',
      options: [['auto', 'Match theme'], ['beige', 'Classic beige'], ['white', 'White'], ['anthracite', 'Anthracite'], ['carbon', 'Carbon fibre']],
      def: FACE, resolve: v => v === 'auto' ? (pageIsDark() ? 'carbon' : 'beige') : v
    },
    bezel: {
      label: 'Bezel',
      options: [['auto', 'Match theme'], ['chrome', 'Chrome'], ['black', 'Black metal']],
      def: BEZEL, resolve: v => v === 'auto' ? (pageIsDark() ? 'black' : 'chrome') : v
    }
  };
  prefs.look = CONTROLS ? store.get('look', {}) : {};
  const lookChoice = kind => prefs.look[kind] || LOOK[kind].def;
  function applyLook() {
    const face = LOOK.face.resolve(lookChoice('face'));
    const bezel = LOOK.bezel.resolve(lookChoice('bezel'));
    document.querySelectorAll('.gauge-svg').forEach(svg => { svg.dataset.face = face; svg.dataset.bezel = bezel; });
    document.querySelectorAll('.look-menu [role="menuitemradio"]').forEach(b => {
      b.setAttribute('aria-checked', String(lookChoice(b.dataset.kind) === b.dataset.value));
    });
  }
  function buildLookMenu(kind) {
    const btn = document.getElementById(kind + '-btn');
    const menu = document.getElementById(kind + '-menu');
    if (!CONTROLS || !btn || !menu) return;
    menu.innerHTML = `<div class="menu-title">${LOOK[kind].label}</div>` + LOOK[kind].options.map(([v, l]) =>
      `<button type="button" role="menuitemradio" data-kind="${kind}" data-value="${v}"><span class="swatch sw-${kind}-${v}"></span>${l}</button>`).join('');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const open = menu.hidden;
      document.querySelectorAll('.look-menu').forEach(m => { m.hidden = true; });
      document.querySelectorAll('[aria-haspopup="menu"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
      if (open) { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); menu.querySelector('[aria-checked="true"]')?.focus(); }
    });
    menu.addEventListener('click', ev => {
      const item = ev.target.closest('[role="menuitemradio"]');
      if (!item) return;
      if (item.dataset.value === LOOK[kind].def) delete prefs.look[kind]; else prefs.look[kind] = item.dataset.value;
      store.set('look', prefs.look);
      applyLook();
      close(); btn.focus();
    });
    menu.addEventListener('keydown', ev => {
      const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
      const i = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') { close(); btn.focus(); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    document.addEventListener('click', ev => { if (!menu.hidden && !menu.contains(ev.target)) close(); });
  }

  // ------------------------------------------------------------------ units
  const UNIT_INFO = {
    degree_C: ['°C', 1], degree_F: ['°F', 1], degree_K: ['K', 1],
    hPa: ['hPa', 1], mbar: ['mbar', 1], inHg: ['inHg', 2], kPa: ['kPa', 2], mmHg: ['mmHg', 1],
    km_per_hour: ['km/h', 0], mile_per_hour: ['mph', 0], meter_per_second: ['m/s', 1], knot: ['kn', 0],
    mm: ['mm', 1], cm: ['cm', 2], inch: ['in', 2],
    mm_per_hour: ['mm/h', 1], cm_per_hour: ['cm/h', 2], inch_per_hour: ['in/h', 2],
    meter: ['m', 0], foot: ['ft', 0], km: ['km', 1], mile: ['mi', 1],
    percent: ['%', 0], uv_index: ['', 1], watt_per_meter_squared: ['W/m²', 0], degree_compass: ['°', 0]
  };
  // factor to a base unit per group (temperature handled separately)
  const FACTORS = {
    hPa: 1, mbar: 1, inHg: 33.8639, kPa: 10, mmHg: 1.333224,
    km_per_hour: 1 / 3.6, mile_per_hour: 0.44704, meter_per_second: 1, knot: 0.514444,
    mm: 1, cm: 10, inch: 25.4, mm_per_hour: 1, cm_per_hour: 10, inch_per_hour: 25.4,
    meter: 1, foot: 0.3048, km: 1, mile: 1.609344
  };
  const CHOICES = {
    group_temperature: ['degree_C', 'degree_F'],
    group_pressure: ['hPa', 'mbar', 'inHg', 'kPa', 'mmHg'],
    group_speed: ['km_per_hour', 'mile_per_hour', 'meter_per_second', 'knot'],
    group_rain: ['mm', 'cm', 'inch'],
    group_altitude: ['meter', 'foot']
  };
  const GROUP_NAMES = { group_temperature: 'Temperature', group_pressure: 'Barometer', group_speed: 'Wind speed', group_rain: 'Rain', group_altitude: 'Cloud base' };
  const RATE_OF = { mm: 'mm_per_hour', cm: 'cm_per_hour', inch: 'inch_per_hour' };
  const OBS_GROUP = {
    outTemp: 'group_temperature', inTemp: 'group_temperature', dewpoint: 'group_temperature', inDewpoint: 'group_temperature',
    heatindex: 'group_temperature', windchill: 'group_temperature', appTemp: 'group_temperature', humidex: 'group_temperature',
    outHumidity: 'group_percent', inHumidity: 'group_percent',
    barometer: 'group_pressure', pressure: 'group_pressure', altimeter: 'group_pressure',
    windSpeed: 'group_speed', windGust: 'group_speed', windDir: 'group_direction', windGustDir: 'group_direction',
    rain: 'group_rain', rainRate: 'group_rainrate', UV: 'group_uv', radiation: 'group_radiation', cloudbase: 'group_altitude'
  };
  const FIXED_UNIT = { group_percent: 'percent', group_uv: 'uv_index', group_radiation: 'watt_per_meter_squared', group_direction: 'degree_compass' };

  // Units of the host skin (controls = false). display_units are the host
  // report's own units from weewx.conf; on Belchertown-new with its unit
  // switcher turned on (unit_switching = 1), the visitor's choice there wins.
  const BT_SYSTEMS = {
    us:          { group_temperature: 'degree_F', group_speed: 'mile_per_hour',    group_pressure: 'inHg', group_rain: 'inch', group_altitude: 'foot' },
    uk:          { group_temperature: 'degree_C', group_speed: 'mile_per_hour',    group_pressure: 'hPa',  group_rain: 'mm',   group_altitude: 'meter' },
    metric:      { group_temperature: 'degree_C', group_speed: 'km_per_hour',      group_pressure: 'hPa',  group_rain: 'mm',   group_altitude: 'meter' },
    scandinavia: { group_temperature: 'degree_C', group_speed: 'meter_per_second', group_pressure: 'hPa',  group_rain: 'mm',   group_altitude: 'meter' },
    canada:      { group_temperature: 'degree_C', group_speed: 'km_per_hour',      group_pressure: 'kPa',  group_rain: 'mm',   group_altitude: 'meter' },
    nautical:    { group_temperature: 'degree_C', group_speed: 'knot',             group_pressure: 'hPa',  group_rain: 'mm',   group_altitude: 'meter' }
  };
  function hostUnits() {
    let units = Object.assign({}, CFG.display_units || {});
    if (CFG.unit_switcher === 'belchertown' && window.BU_UNIT_SWITCHER_ENABLED === true) {
      let key = null;
      try { key = localStorage.getItem('belchertown_unit_system'); } catch (e) { /* private mode */ }
      if (key && BT_SYSTEMS[key]) units = Object.assign({}, BT_SYSTEMS[key]);
    }
    const out = {};
    for (const [group, u] of Object.entries(units)) if (CHOICES[group]?.includes(u)) out[group] = u;
    return out;
  }
  if (!CONTROLS) prefs.units = hostUnits();

  const normUnit = u => (u || '').replace(/2$/, '');
  let serverUnits = {};              // group -> unit (from realtime.json)

  function srcUnit(group) {
    if (group === 'group_rainrate') return normUnit(serverUnits.group_rainRate?.unit) || RATE_OF[srcUnit('group_rain')] || 'mm_per_hour';
    return normUnit(serverUnits[group]?.unit) || FIXED_UNIT[group] || null;
  }
  function dispUnit(group) {
    if (group === 'group_rainrate') {
      const r = prefs.units.group_rain;
      return r ? RATE_OF[r] : srcUnit(group);
    }
    return prefs.units[group] || srcUnit(group);
  }
  function convertUnit(v, from, to) {
    if (v == null || !Number.isFinite(v) || !from || !to || from === to) return v;
    if (from === 'degree_F' && to === 'degree_C') return (v - 32) * 5 / 9;
    if (from === 'degree_C' && to === 'degree_F') return v * 9 / 5 + 32;
    if (from === 'degree_K') return convertUnit(v - 273.15, 'degree_C', to);
    if (FACTORS[from] && FACTORS[to]) return v * FACTORS[from] / FACTORS[to];
    return v;
  }
  const conv = (v, group) => convertUnit(v, srcUnit(group), dispUnit(group));
  const unitLabel = group => (UNIT_INFO[dispUnit(group)] || [''])[0];
  const unitDp = group => {
    const u = dispUnit(group);
    if (u === srcUnit(group) && serverUnits[group]?.dp != null && group !== 'group_speed') return serverUnits[group].dp;
    return (UNIT_INFO[u] || [0, 1])[1];
  };
  const fmt = (v, dp) => v == null || !Number.isFinite(v) ? '—'
    : v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp, useGrouping: false }).replace('-', '−');
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = d => d == null ? '—' : COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
  const hhmm = d3.timeFormat('%H:%M');
  const hhmmss = d3.timeFormat('%H:%M:%S');

  // ----------------------------------------------------------- colour bands
  const tempC = d3.scaleLinear()
    .domain([-20, -5, 5, 15, 22, 30, 40])
    .range(['#6b5bd6', '#3b82f6', '#22b8cf', '#38c172', '#e6c229', '#f08a24', '#e03e3e'])
    .interpolate(d3.interpolateHcl).clamp(true);
  const BANDS = {
    temp: (v, g) => tempC(convertUnit(v, dispUnit(g), 'degree_C')),
    hum: d3.scaleLinear().domain([0, 30, 60, 100]).range(['#c9853a', '#e6c229', '#38c172', '#2f80ed']).interpolate(d3.interpolateHcl),
    wind: (v, g) => d3.scaleLinear().domain([0, 5, 11, 17, 25]).range(['#38c172', '#9bd13c', '#e6c229', '#f08a24', '#e03e3e']).clamp(true)(convertUnit(v, dispUnit(g), 'meter_per_second')),
    uv: v => v < 3 ? '#38c172' : v < 6 ? '#e6c229' : v < 8 ? '#f08a24' : v < 11 ? '#e03e3e' : '#9b59d0',
    solar: d3.scaleLinear().domain([0, 400, 1000]).range(['#7a6a3a', '#e6c229', '#f08a24']).clamp(true),
    rain: () => '#3b82f6',
    baro: () => null
  };

  // ------------------------------------------------------------- svg utils
  const deg = d => d * Math.PI / 180;
  const polar = (r, a) => [100 + r * Math.sin(deg(a)), 100 - r * Math.cos(deg(a))];
  const arcGen = d3.arc();
  const arcPath = (r0, r1, a0, a1) => arcGen({ innerRadius: r0, outerRadius: r1, startAngle: deg(a0), endAngle: deg(a1) });

  // Shared graphics, defined once and reused by every gauge (<use>).
  // The bezel is a polished-chrome ring: SVG has no conic gradient, so it is
  // built from thin wedges whose colours follow the original SteelSeries gauges' chrome sweep.
  const R_FACE = 84;           // face radius
  const R_BEZEL = 98.5;        // outer bezel radius
  (function defineShared() {
    const svg = d3.select('body').append('svg').attr('width', 0).attr('height', 0).attr('aria-hidden', 'true').style('position', 'absolute');
    const defs = svg.append('defs');
    const stops = (el, list) => list.forEach(([o, c]) => el.append('stop').attr('offset', o).attr('stop-color', c));

    // chrome sweep: angle (deg clockwise from 12 o'clock) -> colour
    const sweep = d3.scaleLinear()
      .domain([0, 25, 55, 95, 125, 150, 185, 215, 245, 285, 305, 330, 360])
      .range(['#e8e8e8', '#a2a4a8', '#c4c7ca', '#f4f4f4', '#ffffff', '#d4d5d7', '#9a9ca1', '#7e8086', '#b3b6ba', '#f1f1f1', '#ffffff', '#cfd0d2', '#e8e8e8'])
      .interpolate(d3.interpolateRgb);
    const ring = defs.append('g').attr('id', 'ss-chrome');
    const N = 120;
    for (let i = 0; i < N; i++) {
      const a0 = 360 * i / N, a1 = 360 * (i + 1) / N;
      ring.append('path').attr('transform', 'translate(100,100)')
        .attr('d', arcPath(R_FACE - .5, R_BEZEL, a0, a1 + .6)).attr('fill', sweep((a0 + a1) / 2));
    }
    // black-metal bezel, same construction with a darker sweep
    const sweepBlack = d3.scaleLinear()
      .domain([0, 25, 55, 95, 125, 150, 185, 215, 245, 285, 305, 330, 360])
      .range(['#4a4c50', '#1c1d20', '#303236', '#6c6f74', '#8a8d92', '#3c3e42', '#17181a', '#0f1012', '#2a2c2f', '#63666b', '#84878c', '#35373a', '#4a4c50'])
      .interpolate(d3.interpolateRgb);
    const ringB = defs.append('g').attr('id', 'ss-blackmetal');
    for (let i = 0; i < N; i++) {
      const a0 = 360 * i / N, a1 = 360 * (i + 1) / N;
      ringB.append('path').attr('transform', 'translate(100,100)')
        .attr('d', arcPath(R_FACE - .5, R_BEZEL, a0, a1 + .6)).attr('fill', sweepBlack((a0 + a1) / 2));
    }

    // Carbon fibre: a 2x2 twill of tiles, alternating weave direction, each
    // tile shaded across its width like a round tow of fibres.
    const CF = 5.2, half = CF / 2;
    const tow = (id, horiz) => {
      const g = defs.append('linearGradient').attr('id', id)
        .attr('x1', 0).attr('y1', 0).attr('x2', horiz ? 0 : 1).attr('y2', horiz ? 1 : 0);
      stops(g, [['0%', '#0c0d0e'], ['30%', '#26282b'], ['50%', '#34373b'], ['70%', '#232528'], ['100%', '#0b0c0d']]);
    };
    tow('ss-cf-h', true); tow('ss-cf-v', false);
    const pat = defs.append('pattern').attr('id', 'ss-carbon-weave').attr('patternUnits', 'userSpaceOnUse')
      .attr('width', CF).attr('height', CF).attr('patternTransform', 'rotate(45 100 100)');
    pat.append('rect').attr('width', CF).attr('height', CF).attr('fill', '#060607');
    [[0, 0, 'h'], [half, half, 'h'], [half, 0, 'v'], [0, half, 'v']].forEach(([x, y, d]) =>
      pat.append('rect').attr('x', x + .15).attr('y', y + .15).attr('width', half - .3).attr('height', half - .3)
        .attr('rx', .35).attr('fill', `url(#ss-cf-${d})`));
    // gloss: a soft sheen across the upper half, as on a lacquered face
    const gloss = defs.append('linearGradient').attr('id', 'ss-carbon-gloss').attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', 0).attr('y1', 100 - R_FACE).attr('x2', 0).attr('y2', 100 + R_FACE);
    stops(gloss, [['0%', 'rgba(255,255,255,.16)'], ['38%', 'rgba(255,255,255,.05)'], ['52%', 'rgba(255,255,255,0)'], ['100%', 'rgba(0,0,0,.25)']]);

    // depth: darker outer lip, light inner lip
    const shade = defs.append('radialGradient').attr('id', 'ss-bezel-shade').attr('gradientUnits', 'userSpaceOnUse')
      .attr('cx', 100).attr('cy', 100).attr('r', R_BEZEL);
    stops(shade, [[(R_FACE / R_BEZEL).toFixed(3), 'rgba(255,255,255,.25)'], ['0.9', 'rgba(255,255,255,0)'], ['0.965', 'rgba(0,0,0,0)'], ['1', 'rgba(0,0,0,.35)']]);

    // faces: radial gradient light centre -> darker rim, colours from CSS vars
    // (gradients resolve colours where they are defined, so each face style
    // gets its own gradient; CSS picks one via --g-face-fill / --g-lcd-fill)
    const FACES = { white: ['#ffffff', '#e1e4e8'], anthracite: ['#454a51', '#1b1e22'] };
    const LCDS = { carbon: ['#2c3035', '#0b0d0f'], beige: ['#aeb6a2', '#a2ab96'], white: ['#f1f3f5', '#c8cdd3'], anthracite: ['#2d3238', '#121518'] };
    for (const [name, [hi, lo]] of Object.entries(FACES)) {
      const g = defs.append('radialGradient').attr('id', 'ss-face-' + name).attr('gradientUnits', 'userSpaceOnUse')
        .attr('cx', 100).attr('cy', 78).attr('r', 112);
      stops(g, [['0%', hi], ['100%', lo]]);
    }
    // Beige as on the original SteelSeries gauges: darker at the top, lighter towards the bottom
    // (colours sampled from the original gauges).
    const beige = defs.append('linearGradient').attr('id', 'ss-face-beige').attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', 0).attr('y1', 100 - R_FACE).attr('x2', 0).attr('y2', 100 + R_FACE);
    stops(beige, [['0%', '#c3c0aa'], ['12%', '#c8c5b3'], ['50%', '#d2d2c0'], ['85%', '#e1e1d0'], ['100%', '#e4e4d4']]);
    for (const [name, [hi, lo]] of Object.entries(LCDS)) {
      const g = defs.append('linearGradient').attr('id', 'ss-lcd-' + name).attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 1);
      stops(g, [['0%', hi], ['100%', lo]]);
    }
    const inner = defs.append('radialGradient').attr('id', 'ss-face-shadow').attr('gradientUnits', 'userSpaceOnUse')
      .attr('cx', 100).attr('cy', 100).attr('r', R_FACE);
    stops(inner, [['0.86', 'rgba(0,0,0,0)'], ['1', 'rgba(0,0,0,.22)']]);

    // LCD panel

    // chrome knob
    const knob = defs.append('radialGradient').attr('id', 'ss-knob').attr('cx', '38%').attr('cy', '32%').attr('r', '75%');
    stops(knob, [['0%', '#ffffff'], ['35%', '#d6d7d9'], ['75%', '#8d8f93'], ['100%', '#55575b']]);
  })();

  function drawCase(svg) {
    svg.append('circle').attr('cx', 100).attr('cy', 100).attr('r', R_BEZEL + .8).attr('fill', '#6e7075');
    svg.append('use').attr('href', '#ss-chrome').attr('class', 'bz-chrome');
    svg.append('use').attr('href', '#ss-blackmetal').attr('class', 'bz-black');
    svg.append('circle').attr('cx', 100).attr('cy', 100).attr('r', R_BEZEL).attr('fill', 'url(#ss-bezel-shade)');
    svg.append('circle').attr('cx', 100).attr('cy', 100).attr('r', R_BEZEL - .7).attr('fill', 'none')
      .attr('stroke', 'rgba(255,255,255,.55)').attr('stroke-width', .7);
    svg.append('circle').attr('cx', 100).attr('cy', 100).attr('r', R_FACE).style('fill', 'var(--g-face-fill)');
    svg.append('circle').attr('cx', 100).attr('cy', 100).attr('r', R_FACE).style('fill', 'var(--g-face-gloss, none)');
    svg.append('circle').attr('cx', 100).attr('cy', 100).attr('r', R_FACE).attr('fill', 'url(#ss-face-shadow)')
      .attr('stroke', 'rgba(0,0,0,.45)').attr('stroke-width', 1);
  }
  function drawHub(g) {
    g.append('circle').attr('cx', 100).attr('cy', 101).attr('r', 8.5).attr('fill', 'rgba(0,0,0,.25)');
    g.append('circle').attr('cx', 100).attr('cy', 100).attr('r', 8).attr('fill', 'url(#ss-knob)')
      .attr('stroke', '#5a5c60').attr('stroke-width', .6);
    g.append('circle').attr('cx', 100).attr('cy', 100).attr('r', 3.2).attr('fill', 'none')
      .attr('stroke', 'rgba(255,255,255,.55)').attr('stroke-width', .6);
  }
  // Two-tone tapered pointer, as on the original SteelSeries gauges (lit left edge, shaded right).
  function drawPointer(g, tipR, tailR) {
    const t = 100 - tipR, b = 100 + tailR;
    g.append('path').attr('d', `M100 ${t} L96.8 ${b} L100 ${b} Z`).attr('fill', 'var(--g-needle-hi)');
    g.append('path').attr('d', `M100 ${t} L103.2 ${b} L100 ${b} Z`).attr('fill', 'var(--g-needle-lo)');
    g.attr('filter', 'drop-shadow(0 1.2px 1.2px rgba(0,0,0,.4))');
  }
  function drawLcd(g, x, y, w, h) {
    g.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 3)
      .style('fill', 'var(--g-lcd-fill)').attr('stroke', 'var(--g-lcd-edge)').attr('stroke-width', 1);
    g.append('rect').attr('x', x + 1).attr('y', y + 1).attr('width', w - 2).attr('height', 2).attr('rx', 1)
      .attr('fill', 'rgba(0,0,0,.08)');
  }

  const tooltip = document.getElementById('tooltip');
  const tooltipHome = tooltip.parentNode;   // stays inside the page's scoped styles
  function showTip(html, ev) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
    tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
  }
  const hideTip = () => { tooltip.hidden = true; };

  // ---------------------------------------------------------- radial gauge
  const A0 = -120, A1 = 120;

  class RadialGauge {
    constructor(svgEl, opts) {
      this.o = opts;
      this.svg = d3.select(svgEl).attr('viewBox', '0 0 200 200');
      drawCase(this.svg);
      this.gBand = this.svg.append('g');
      this.gRange = this.svg.append('path').attr('fill', 'var(--g-range)');
      this.gTicks = this.svg.append('g');
      this.unitText = this.svg.append('text').attr('x', 100).attr('y', 74).attr('text-anchor', 'middle')
        .attr('font-size', 9.5).attr('fill', 'var(--g-ink-2)');
      this.gMarks = this.svg.append('g');
      this.needle = this.svg.append('g').attr('transform', `rotate(${A0} 100 100)`);
      drawPointer(this.needle, 74, 14);
      drawHub(this.svg.append('g'));
      this.lcd = this.svg.append('g');
      drawLcd(this.lcd, 63, 120, 74, 30);
      this.valueText = this.lcd.append('text').attr('class', 'lcd').attr('x', 100).attr('y', 135).attr('dominant-baseline', 'central')
        .attr('text-anchor', 'middle').attr('font-size', 20).attr('font-weight', 500).attr('fill', 'var(--g-lcd-ink)').text('—');
      this.hiloText = this.svg.append('text').attr('x', 100).attr('y', 164).attr('text-anchor', 'middle')
        .attr('font-size', 9).attr('fill', 'var(--g-ink-2)');
      this.angle = A0;
      this.shown = null;
      this.domainKey = '';
    }

    setDomain(lo, hi, group) {
      const key = `${lo}|${hi}|${dispUnit(group)}|${this.o.band}`;
      if (key === this.domainKey) return;
      this.domainKey = key;
      this.x = d3.scaleLinear().domain([lo, hi]).range([A0, A1]).clamp(true);
      const x = this.x;
      const majors = x.ticks(this.o.ticks || 7);
      const step = majors.length > 1 ? majors[1] - majors[0] : (hi - lo) / 5;
      const minors = d3.range(lo, hi + step / 1e6, step / 5).filter(v => v >= lo && v <= hi);
      const dp = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

      this.gTicks.selectAll('*').remove();
      minors.forEach(v => {
        const a = x(v); const [x1, y1] = polar(81.5, a); const [x2, y2] = polar(77.5, a);
        this.gTicks.append('line').attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
          .attr('stroke', 'var(--g-tick-minor)').attr('stroke-width', .8);
      });
      majors.forEach(v => {
        const a = x(v); const [x1, y1] = polar(81.5, a); const [x2, y2] = polar(72.5, a);
        this.gTicks.append('line').attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
          .attr('stroke', 'var(--g-tick)').attr('stroke-width', 1.6).attr('stroke-linecap', 'round');
        const [tx, ty] = polar(62, a);
        this.gTicks.append('text').attr('x', tx).attr('y', ty + 3.5).attr('text-anchor', 'middle')
          .attr('font-size', majors.length > 8 ? 8 : 9).attr('fill', 'var(--g-tick)').text(fmt(v, dp));
      });

      // colour band
      this.gBand.selectAll('*').remove();
      const bandFn = BANDS[this.o.band];
      const N = 60;
      if (bandFn && bandFn(lo, group)) {
        for (let i = 0; i < N; i++) {
          const a0 = A0 + (A1 - A0) * i / N, a1 = A0 + (A1 - A0) * (i + 1) / N + .4;
          const v = x.invert((a0 + a1) / 2);
          this.gBand.append('path').attr('transform', 'translate(100,100)')
            .attr('d', arcPath(77.5, 82, a0, Math.min(a1, A1))).attr('fill', bandFn(v, group)).style('opacity', 'var(--g-band-op, .55)');
        }
      } else {
        this.gBand.append('path').attr('transform', 'translate(100,100)').attr('d', arcPath(80.5, 81.5, A0, A1)).attr('fill', 'var(--g-tick-minor)');
      }
    }

    update(d) {
      // d = {value, min, max, group, markers:[{v, kind, title}], range:[a,b], label}
      const { group } = d;
      const base = this.o.fixed || RANGES[dispUnit(group)] || this.o.fallback || [0, 100];
      const vals = [d.value, d.min, d.max, ...(d.markers || []).map(m => m.v)].filter(Number.isFinite);
      let lo = Math.min(base[0], ...vals), hi = Math.max(base[1], ...vals);
      if (lo < base[0] || hi > base[1]) [lo, hi] = d3.scaleLinear().domain([lo, hi]).nice(6).domain();
      this.setDomain(lo, hi, group);
      const x = this.x;

      this.unitText.text(unitLabel(group));
      const r = d.range || [d.min, d.max];
      if (Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]) {
        this.gRange.attr('transform', 'translate(100,100)').attr('d', arcPath(72.5, 77.5, x(r[0]), x(r[1])));
      } else this.gRange.attr('d', null);

      const dp = unitDp(group);
      const marks = [];
      if (Number.isFinite(d.min) && !d.markers) marks.push({ v: d.min, kind: 'min', title: `Low today ${fmt(d.min, dp)} ${unitLabel(group)}${d.mintime ? ' at ' + hhmm(new Date(d.mintime * 1000)) : ''}` });
      if (Number.isFinite(d.max) && !d.markers) marks.push({ v: d.max, kind: 'max', title: `High today ${fmt(d.max, dp)} ${unitLabel(group)}${d.maxtime ? ' at ' + hhmm(new Date(d.maxtime * 1000)) : ''}` });
      (d.markers || []).forEach(m => marks.push(m));
      const colour = { min: '#4aa3ff', max: '#ff5a5a', avg: 'var(--g-accent)', gust: '#ff5a5a' };
      const sel = this.gMarks.selectAll('path').data(marks, m => m.kind);
      sel.exit().remove();
      sel.enter().append('path')
        .attr('d', m => m.kind === 'avg' ? 'M0 0 L-4.5 -8 L4.5 -8 Z' : 'M0 0 L-4 -7.5 L4 -7.5 Z')
        .attr('fill', m => m.kind === 'avg' ? 'none' : colour[m.kind])
        .attr('stroke', m => colour[m.kind]).attr('stroke-width', m => m.kind === 'avg' ? 1.6 : 0)
        .style('cursor', 'help')
        .on('mousemove', (ev, m) => showTip(m.title, ev)).on('mouseleave', hideTip)
        .merge(sel)
        .each(function (m) { this.__title = m.title; })
        .transition().duration(700).ease(d3.easeCubicOut)
        .attr('transform', m => {
          const a = x(m.v); const [px, py] = polar(81.5, a);
          return `translate(${px},${py}) rotate(${a + 180})`;
        });
      this.gMarks.selectAll('path').on('mousemove', function (ev) { showTip(this.__title, ev); });

      const hi_ = Number.isFinite(d.max) ? `▲ ${fmt(d.max, dp)}` : '';
      const lo_ = Number.isFinite(d.min) ? `▼ ${fmt(d.min, dp)}` : '';
      this.hiloText.text(d.subline != null ? d.subline : [lo_, hi_].filter(Boolean).join('   '));

      // needle and readout
      const target = Number.isFinite(d.value) ? x(d.value) : A0;
      const from = this.angle;
      this.angle = target;
      this.needle.transition().duration(900).ease(d3.easeCubicOut)
        .attrTween('transform', () => t => `rotate(${from + (target - from) * t} 100 100)`);
      const prev = this.shown;
      this.shown = d.value;
      const len = fmt(d.value, dp).length;
      this.valueText.attr('font-size', len > 7 ? 13.5 : len > 6 ? 15.5 : len > 5 ? 17.5 : 20);
      if (!Number.isFinite(d.value)) { this.valueText.text('—'); return; }
      if (!Number.isFinite(prev)) { this.valueText.text(fmt(d.value, dp)); return; }
      this.valueText.transition().duration(900).ease(d3.easeCubicOut)
        .tween('text', function () { const i = d3.interpolateNumber(prev, d.value); return t => { this.textContent = fmt(i(t), dp); }; });
    }
  }

  // --------------------------------------------------------- compass gauge
  class CompassGauge {
    constructor(svgEl) {
      this.svg = d3.select(svgEl).attr('viewBox', '0 0 200 200');
      drawCase(this.svg);
      this.range = this.svg.append('path').attr('transform', 'translate(100,100)').attr('fill', 'var(--g-range)');
      const g = this.svg.append('g');
      for (let a = 0; a < 360; a += 5) {
        const major = a % 45 === 0, mid = a % 15 === 0;
        const [x1, y1] = polar(81.5, a); const [x2, y2] = polar(major ? 72.5 : mid ? 76.5 : 79, a);
        g.append('line').attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
          .attr('stroke', major ? 'var(--g-tick)' : 'var(--g-tick-minor)').attr('stroke-width', major ? 1.6 : .8);
      }
      ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].forEach((t, i) => {
        const [tx, ty] = polar(i % 2 ? 64 : 65, i * 45);
        g.append('text').attr('x', tx).attr('y', ty + 4).attr('text-anchor', 'middle')
          .attr('font-size', i % 2 ? 9 : 12.5).attr('font-weight', i % 2 ? 500 : 700)
          .attr('fill', t === 'N' ? 'var(--g-north)' : i % 2 ? 'var(--g-ink-2)' : 'var(--g-tick)').text(t);
      });
      this.avg = this.svg.append('path').attr('d', 'M0 0 L-5 -9 L5 -9 Z').attr('fill', 'none')
        .attr('stroke', 'var(--g-accent)').attr('stroke-width', 1.8).attr('opacity', 0);
      this.needle = this.svg.append('g');
      this.needle.append('path').attr('d', 'M100 27 L95 100 L100 100 Z').attr('fill', 'var(--g-needle-hi)');
      this.needle.append('path').attr('d', 'M100 27 L105 100 L100 100 Z').attr('fill', 'var(--g-needle-lo)');
      this.needle.append('path').attr('d', 'M95 100 L100 100 L100 173 Z').attr('fill', '#d9dadc');
      this.needle.append('path').attr('d', 'M105 100 L100 100 L100 173 Z').attr('fill', '#a9abaf');
      this.needle.attr('filter', 'drop-shadow(0 1.2px 1.2px rgba(0,0,0,.4))');
      const lcd = this.svg.append('g');
      drawLcd(lcd, 66, 116, 68, 22);
      drawHub(this.svg.append('g'));
      this.valueText = lcd.append('text').attr('class', 'lcd').attr('x', 100).attr('y', 127).attr('dominant-baseline', 'central').attr('text-anchor', 'middle')
        .attr('font-size', 12.5).attr('font-weight', 500).attr('fill', 'var(--g-lcd-ink)').text('—');
      this.angle = 0; this.avgAngle = null;
    }
    update(dir, avgDir, from, to) {
      if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
        let b = to; if (b < from) b += 360;
        this.range.attr('d', arcPath(30, 81.5, from, b));
      } else this.range.attr('d', null);
      if (Number.isFinite(avgDir)) {
        const [px, py] = polar(81.5, avgDir);
        this.avg.attr('opacity', 1).transition().duration(900)
          .attr('transform', `translate(${px},${py}) rotate(${avgDir + 180})`);
      } else this.avg.attr('opacity', 0);
      if (Number.isFinite(dir)) {
        const start = this.angle;
        const delta = ((dir - start) % 360 + 540) % 360 - 180;
        this.angle = start + delta;
        this.needle.transition().duration(1000).ease(d3.easeCubicOut)
          .attrTween('transform', () => t => `rotate(${start + delta * t} 100 100)`);
        this.valueText.text(`${compass(dir)} ${fmt(((dir % 360) + 360) % 360, 0)}°`);
        this.needle.attr('opacity', 1);
      } else {
        this.valueText.text('Calm');
        this.needle.attr('opacity', .35);
      }
    }
  }

  // ------------------------------------------------------------- wind rose
  class RoseChart {
    constructor(svgEl) {
      this.svg = d3.select(svgEl).attr('viewBox', '0 0 200 200');
      drawCase(this.svg);
      this.grid = this.svg.append('g');
      [.25, .5, .75, 1].forEach(f => this.grid.append('circle').attr('cx', 100).attr('cy', 100)
        .attr('r', 14 + 54 * Math.sqrt(f)).attr('fill', 'none').attr('stroke', 'var(--g-tick-minor)')
        .attr('stroke-dasharray', f === 1 ? null : '2 3').attr('stroke-width', .8));
      ['N', 'E', 'S', 'W'].forEach((t, i) => {
        const [x, y] = polar(76, i * 90);
        this.grid.append('text').attr('x', x).attr('y', y + 3.5).attr('text-anchor', 'middle').attr('font-size', 9.5)
          .attr('font-weight', 700).attr('fill', t === 'N' ? 'var(--g-north)' : 'var(--g-tick)').text(t);
      });
      this.petals = this.svg.append('g').attr('transform', 'translate(100,100)');
      this.center = this.svg.append('text').attr('x', 100).attr('y', 103).attr('text-anchor', 'middle')
        .attr('font-size', 9).attr('fill', 'var(--g-ink-2)');
    }
    update(rose) {
      const data = (rose || []).map((v, i) => ({ v, i }));
      const max = d3.max(data, d => d.v) || 0;
      const r = d3.scaleSqrt().domain([0, max || 1]).range([14, 68]);
      const sel = this.petals.selectAll('path').data(data, d => d.i);
      sel.enter().append('path').attr('stroke', 'var(--g-face-lo)').attr('stroke-width', 1)
        .on('mousemove', (ev, d) => showTip(`<b>${COMPASS[d.i]}</b> ${fmt(d.v * 100, 1)}% of today's wind run`, ev))
        .on('mouseleave', hideTip)
        .merge(sel)
        .attr('fill', d => d.v === max && max > 0 ? 'var(--g-accent)' : 'color-mix(in srgb, var(--g-accent) ' + Math.round(35 + 55 * (d.v / (max || 1))) + '%, var(--g-face-lo))')
        .transition().duration(800)
        .attr('d', d => arcPath(14, r(d.v), d.i * 22.5 - 10.5, d.i * 22.5 + 10.5));
      this.center.text(max ? compass(d3.maxIndex(data, d => d.v) * 22.5) : 'calm');
    }
  }

  // ------------------------------------------------------------- sparkline
  function drawSpark(container, series, group, color) {
    if (!container) return;
    const W = 200, H = 34;
    const svg = d3.select(container).selectAll('svg').data([0]).join('svg')
      .attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'none');
    const pts = (series || []).filter(p => Number.isFinite(p[1]));
    if (pts.length < 2) { svg.selectAll('*').remove(); return; }
    const x = d3.scaleLinear().domain(d3.extent(pts, p => p[0])).range([1, W - 1]);
    const ext = d3.extent(pts, p => p[1]);
    if (ext[0] === ext[1]) { ext[0] -= 1; ext[1] += 1; }
    const y = d3.scaleLinear().domain(ext).range([H - 2, 3]);
    const area = d3.area().x(p => x(p[0])).y0(H).y1(p => y(p[1])).curve(d3.curveMonotoneX);
    const line = d3.line().x(p => x(p[0])).y(p => y(p[1])).curve(d3.curveMonotoneX);
    svg.selectAll('path.a').data([pts]).join('path').attr('class', 'a').attr('d', area)
      .attr('fill', color || 'var(--accent)').attr('opacity', .14);
    svg.selectAll('path.l').data([pts]).join('path').attr('class', 'l').attr('d', line)
      .attr('fill', 'none').attr('stroke', color || 'var(--accent)').attr('stroke-width', 1.5)
      .attr('vector-effect', 'non-scaling-stroke');
  }

  // ---------------------------------------------------------- detail chart
  function drawDetail(el, title, seriesList, group) {
    const W = 880, H = 360, m = { t: 12, r: 16, b: 28, l: 48 };
    el.innerHTML = '';
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`);
    const all = seriesList.flatMap(s => s.pts.filter(p => Number.isFinite(p[1])));
    if (all.length < 2) { svg.append('text').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text('Not enough history yet'); return; }
    const x = d3.scaleTime().domain(d3.extent(all, p => p[0] * 1000)).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain(d3.extent(all, p => p[1])).nice().range([H - m.b, m.t]);
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(8).tickFormat(d3.timeFormat('%H:%M')));
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(W - m.l - m.r)))
      .call(g => g.selectAll('.tick line').attr('stroke-opacity', .5)).call(g => g.select('.domain').remove());
    svg.append('text').attr('x', m.l).attr('y', m.t - 2).attr('font-size', 11).text(unitLabel(group));
    seriesList.forEach((s, i) => {
      const pts = s.pts.filter(p => Number.isFinite(p[1]));
      if (i === 0) svg.append('path').datum(pts).attr('fill', s.color).attr('opacity', .1)
        .attr('d', d3.area().x(p => x(p[0] * 1000)).y0(H - m.b).y1(p => y(p[1])).curve(d3.curveMonotoneX));
      svg.append('path').datum(pts).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', i === 0 ? 2 : 1.4)
        .attr('stroke-dasharray', i === 0 ? null : '4 3')
        .attr('d', d3.line().x(p => x(p[0] * 1000)).y(p => y(p[1])).curve(d3.curveMonotoneX));
    });
    // legend
    const lg = svg.append('g').attr('transform', `translate(${W - m.r},${m.t + 2})`);
    seriesList.slice().reverse().reduce((off, s) => {
      const t = lg.append('text').attr('x', -off).attr('y', 0).attr('text-anchor', 'end').style('fill', s.color).attr('font-size', 11.5).text(s.label);
      return off + t.node().getComputedTextLength() + 16;
    }, 0);
    // crosshair
    const cross = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--ink-2)').attr('stroke-dasharray', '2 3').attr('opacity', 0);
    const dots = seriesList.map(s => svg.append('circle').attr('r', 3.5).attr('fill', s.color).attr('opacity', 0));
    const dp = unitDp(group);
    const bis = d3.bisector(p => p[0]).center;
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b).attr('fill', 'transparent')
      .on('pointermove', ev => {
        const [px] = d3.pointer(ev);
        const t = x.invert(px) / 1000;
        cross.attr('x1', px).attr('x2', px).attr('opacity', 1);
        const rows = seriesList.map((s, i) => {
          const p = s.pts[bis(s.pts, t)];
          if (!p || !Number.isFinite(p[1])) { dots[i].attr('opacity', 0); return ''; }
          dots[i].attr('cx', x(p[0] * 1000)).attr('cy', y(p[1])).attr('opacity', 1);
          return `<div><span style="color:${s.color}">●</span> ${s.label} <b>${fmt(p[1], dp)}</b> ${unitLabel(group)}</div>`;
        });
        showTip(`<div class="muted">${hhmm(new Date(t * 1000))}</div>${rows.join('')}`, ev);
      })
      .on('pointerleave', () => { cross.attr('opacity', 0); dots.forEach(d => d.attr('opacity', 0)); hideTip(); });
  }

  // ------------------------------------------------------------------ state
  const state = { rt: null, history: { time: [] }, live: {}, calendar: null, fetchedAt: 0, serverAge: 0 };

  function seriesFor(obs) {
    // [ [ts, displayValue], ... ] from archive history + live samples
    const g = OBS_GROUP[obs];
    const h = state.history[obs] || [];
    const pts = state.history.time.map((t, i) => [t, conv(h[i], g)]);
    const lastT = pts.length ? pts[pts.length - 1][0] : 0;
    for (const p of state.live[obs] || []) if (p[0] > lastT) pts.push([p[0], conv(p[1], g)]);
    return pts;
  }
  function recordLive(rt) {
    const ts = rt.dateTime;
    const cutoff = ts - (parseFloat(CFG.history_hours) || 24) * 3600;
    for (const [obs, v] of Object.entries(rt.current || {})) {
      if (!(obs in OBS_GROUP) || !Number.isFinite(v)) continue;
      const arr = state.live[obs] || (state.live[obs] = []);
      if (!arr.length || ts - arr[arr.length - 1][0] >= 60) arr.push([ts, v]);
      else arr[arr.length - 1] = [arr[arr.length - 1][0], v];
      while (arr.length && arr[0][0] < cutoff) arr.shift();
    }
  }
  const hasObs = obs => Number.isFinite(state.rt?.current?.[obs]) || (state.history[obs] || []).some(Number.isFinite);

  // ---------------------------------------------------------------- gauges
  const TEMP_OPTS = [['outTemp', 'Outside'], ['inTemp', 'Inside']];
  const FEELS_OPTS = [['dewpoint', 'Dew point'], ['appTemp', 'Feels like'], ['windchill', 'Wind chill'], ['heatindex', 'Heat index'], ['humidex', 'Humidex']];
  const DEFS = {
    temp: { title: 'Temperature', options: TEMP_OPTS, band: 'temp' },
    dew: { title: 'Dew point', options: FEELS_OPTS, band: 'temp' },
    hum: { title: 'Humidity', options: [['outHumidity', 'Outside'], ['inHumidity', 'Inside']], band: 'hum', fixed: [0, 100] },
    baro: { title: 'Barometer', options: [['barometer', 'Sea level']], band: 'baro' },
    wind: { title: 'Wind speed', options: [['windSpeed', 'Speed']], band: 'wind' },
    dir: { title: 'Wind direction', kind: 'compass', options: [['windDir', 'Direction']] },
    rose: { title: 'Wind rose', kind: 'rose', options: [['windDir', 'Today']] },
    rain: { title: 'Rain today', options: [['rain', 'Today']], band: 'rain', obsGroup: 'group_rain' },
    rainrate: { title: 'Rain rate', options: [['rainRate', 'Rate']], band: 'rain' },
    uv: { title: 'UV index', options: [['UV', 'UV']], band: 'uv', fallback: [0, 12] },
    solar: { title: 'Solar radiation', options: [['radiation', 'Solar']], band: 'solar', fallback: [0, 1200] },
    cloudbase: { title: 'Cloud base', options: [['cloudbase', 'Cloud base']], band: 'baro' }
  };
  const CARDS = [];
  const grid = document.getElementById('gauges');

  function buildCards() {
    for (const id of GAUGE_ORDER) {
      const def = DEFS[id];
      if (!def) continue;
      const card = document.createElement('article');
      card.className = 'card';
      card.hidden = true;
      card.innerHTML = `<div class="card-head"><h3 class="card-title">${def.title}</h3></div>
        <svg class="gauge-svg" role="img" aria-label="${def.title}"></svg>
        <p class="card-note"></p>
        ${SHOW_SPARKS ? `<div class="card-foot"><button class="spark-btn" type="button" aria-label="${def.title}: show 24-hour history"><div class="spark"></div></button></div>` : ''}`;
      grid.appendChild(card);
      const svg = card.querySelector('svg');
      const gauge = def.kind === 'compass' ? new CompassGauge(svg) : def.kind === 'rose' ? new RoseChart(svg) : new RadialGauge(svg, def);
      const c = { id, def, card, gauge, select: null, obs: prefs.obs[id] || def.options[0][0] };
      if (def.options.length > 1) {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `${def.title} measure`);
        sel.addEventListener('change', () => {
          c.obs = sel.value; prefs.obs[id] = c.obs; store.set('obs', prefs.obs);
          card.querySelector('.card-title').textContent = sel.value in Object.fromEntries(FEELS_OPTS) ? sel.selectedOptions[0].text : def.title;
          c.gauge.domainKey = ''; renderCard(c);
        });
        card.querySelector('.card-head').appendChild(sel);
        c.select = sel;
      }
      card.querySelector('.spark-btn')?.addEventListener('click', () => openDetail(c));
      CARDS.push(c);
    }
  }

  function renderCard(c) {
    const rt = state.rt;
    if (!rt) return;
    const { def } = c;
    const cur = rt.current || {};
    // options available
    if (c.select) {
      const avail = def.options.filter(([o]) => hasObs(o));
      const key = avail.map(a => a[0]).join();
      if (c.select.dataset.key !== key) {
        c.select.dataset.key = key;
        c.select.innerHTML = avail.map(([o, l]) => `<option value="${o}">${l}</option>`).join('');
        c.select.hidden = avail.length < 2;
      }
      if (!avail.some(a => a[0] === c.obs) && avail.length) c.obs = avail[0][0];
      c.select.value = c.obs;
      if (def.options === FEELS_OPTS) c.card.querySelector('.card-title').textContent = (FEELS_OPTS.find(o => o[0] === c.obs) || [0, def.title])[1];
    }
    const obs = c.obs;
    const visible = c.id === 'rain' ? rt.rain && rt.rain.day != null : c.id === 'rose' ? hasObs('windSpeed') : hasObs(obs);
    c.card.hidden = !visible;
    if (!visible) return;
    const note = c.card.querySelector('.card-note');
    const spark = c.card.querySelector('.spark');

    if (c.id === 'dir') {
      const w = rt.wind || {};
      c.gauge.update(cur.windSpeed ? cur.windDir : null, w.avgDir, w.dirFrom, w.dirTo);
      note.textContent = Number.isFinite(w.avgDir) ? `Avg ${compass(w.avgDir)} ${fmt(w.avgDir, 0)}°` + (Number.isFinite(w.dirFrom) && w.dirFrom !== w.dirTo ? ` · range ${fmt(w.dirFrom, 0)}°–${fmt(w.dirTo, 0)}°` : '') : 'Calm';
      drawSpark(spark, seriesFor('windDir'), 'group_direction', 'var(--ink-2)');
      return;
    }
    if (c.id === 'rose') {
      c.gauge.update(rt.wind?.rose);
      note.textContent = 'Today, weighted by wind run';
      drawSpark(spark, seriesFor('windSpeed'), 'group_speed');
      return;
    }

    const group = def.obsGroup || OBS_GROUP[obs] || rt.obsGroups?.[obs];
    const day = rt.day?.[obs] || {};
    const d = {
      group,
      value: conv(cur[obs], group),
      min: conv(day.min, group), max: conv(day.max, group), mintime: day.mintime, maxtime: day.maxtime
    };
    const dp = unitDp(group);
    const U = unitLabel(group);
    let noteText = '';

    if (c.id === 'rain') {
      const r = rt.rain || {};
      d.value = conv(r.day, group); d.min = d.max = undefined;
      d.subline = Number.isFinite(conv(r.lastHour, group)) ? `last hour ${fmt(conv(r.lastHour, group), dp)}` : '';
      noteText = `Month ${fmt(conv(r.month, group), dp)} · Year ${fmt(conv(r.year, group), dp)} ${U}`;
    } else if (c.id === 'wind') {
      const w = rt.wind || {};
      const avg = conv(w.avg, group), gust = conv(w.gust, group);
      d.markers = [];
      if (Number.isFinite(avg)) d.markers.push({ v: avg, kind: 'avg', title: `${Math.round(w.period / 60)}-min average ${fmt(avg, dp)} ${U}` });
      if (Number.isFinite(gust)) d.markers.push({ v: gust, kind: 'gust', title: `${Math.round(w.period / 60)}-min gust ${fmt(gust, dp)} ${U}` });
      d.range = [avg, gust];
      const dayGust = conv(rt.day?.windGust?.max, group);
      d.subline = Number.isFinite(dayGust) ? `▲ ${fmt(dayGust, dp)} gust today` : '';
      noteText = `Avg ${fmt(avg, dp)} · Gust ${fmt(gust, dp)} ${U} (${Math.round((w.period || 600) / 60)} min)`;
    } else if (c.id === 'baro') {
      const t = rt.baroTrend || {};
      const ch = conv(t.change, group);
      const arrow = !Number.isFinite(ch) ? '' : Math.abs(ch) < 1e-9 || t.text === 'Steady' ? '→ ' : ch > 0 ? '↗ ' : '↘ ';
      noteText = t.text ? `${arrow}${t.text} · ${ch > 0 ? '+' : ''}${fmt(ch, dp)} ${U} / 3 h` : '';
    } else {
      const times = [];
      if (d.mintime) times.push(`low ${hhmm(new Date(d.mintime * 1000))}`);
      if (d.maxtime) times.push(`high ${hhmm(new Date(d.maxtime * 1000))}`);
      noteText = times.length ? `Today: ${times.join(' · ')}` : '';
    }
    note.textContent = noteText;
    c.gauge.update(d);
    const sparkObs = c.id === 'rain' ? 'rainRate' : obs;
    drawSpark(spark, seriesFor(sparkObs), OBS_GROUP[sparkObs], def.band === 'temp' ? BANDS.temp(d.value ?? 15, group) : undefined);
  }

  function openDetail(c) {
    const dlg = document.getElementById('detail');
    const obs = c.id === 'rain' ? 'rainRate' : c.id === 'rose' ? 'windSpeed' : c.obs;
    let list = [{ label: (c.def.options.find(o => o[0] === obs) || [0, c.def.title])[1], pts: seriesFor(obs), color: 'var(--accent)' }];
    if (obs === 'outTemp') list.push({ label: 'Dew point', pts: seriesFor('dewpoint'), color: '#4aa3ff' });
    if (obs === 'windSpeed') { list[0].label = 'Average'; list.push({ label: 'Gust', pts: seriesFor('windGust'), color: '#ff5a5a' }); }
    list = list.filter(s => s.pts.some(p => Number.isFinite(p[1])));
    document.getElementById('detail-title').textContent = `${c.card.querySelector('.card-title').textContent} — last ${parseFloat(CFG.history_hours) || 24} hours`;
    dlg.showModal();
    dlg.appendChild(tooltip);            // dialogs sit in the top layer
    drawDetail(document.getElementById('detail-chart'), c.def.title, list, OBS_GROUP[obs] || 'group_direction');
  }
  document.getElementById('detail').addEventListener('close', () => { hideTip(); tooltipHome.appendChild(tooltip); });

  // -------------------------------------------------------------- calendar
  const CAL_METRICS = [
    { key: 'tmax', label: 'Max temp', group: 'group_temperature', scheme: 'temp' },
    { key: 'tavg', label: 'Mean temp', group: 'group_temperature', scheme: 'temp' },
    { key: 'tmin', label: 'Min temp', group: 'group_temperature', scheme: 'temp' },
    { key: 'rain', label: 'Rain', group: 'group_rain', scheme: d3.interpolateBlues, zero: true },
    { key: 'gust', label: 'Max gust', group: 'group_speed', scheme: d3.interpolatePuBu },
    { key: 'hum', label: 'Humidity', group: 'group_percent', scheme: d3.interpolateGnBu },
    { key: 'uv', label: 'UV', group: 'group_uv', scheme: d3.interpolateYlOrRd },
    { key: 'solar', label: 'Solar', group: 'group_radiation', scheme: d3.interpolateYlOrBr }
  ];
  const dayFmt = d3.timeFormat('%a %e %b %Y');

  function renderCalendar() {
    const panel = document.getElementById('calendar-panel');
    if (!SHOW_CALENDAR) { panel.hidden = true; return; }
    const days = state.calendar?.days || [];
    if (!days.length) { panel.hidden = true; return; }
    panel.hidden = false;
    const metrics = CAL_METRICS.filter(m => days.some(d => Number.isFinite(d[m.key])));
    let metric = metrics.find(m => m.key === prefs.calMetric) || metrics[0];
    const seg = document.getElementById('cal-metric');
    seg.innerHTML = '';
    metrics.forEach(m => {
      const b = document.createElement('button');
      b.type = 'button'; b.role = 'tab'; b.textContent = m.label;
      b.setAttribute('aria-selected', m === metric);
      b.addEventListener('click', () => { prefs.calMetric = m.key; store.set('calMetric', m.key); renderCalendar(); });
      seg.appendChild(b);
    });

    const parse = s => { const [y, mo, d] = s.split('-').map(Number); return new Date(y, mo - 1, d); };
    const rows = days.map(d => ({ date: parse(d.date), v: metric.group === 'group_percent' || metric.group === 'group_uv' || metric.group === 'group_radiation' ? d[metric.key] : conv(d[metric.key], metric.group) }));
    const first = rows[0].date, last = rows[rows.length - 1].date;
    const dow = dt => (dt.getDay() + 6) % 7;                      // Monday = 0
    const start = d3.timeDay.offset(first, -dow(first));
    const idx = dt => Math.round((dt - start) / 864e5);
    const cs = 13, L = 30, T = 18;
    const weeks = Math.floor(idx(last) / 7) + 1;
    const W = L + weeks * cs + 4, H = T + 7 * cs + 2;

    const vals = rows.map(r => r.v).filter(Number.isFinite);
    let color;
    if (metric.scheme === 'temp') {
      color = v => tempC(convertUnit(v, dispUnit('group_temperature'), 'degree_C'));
    } else {
      const max = d3.max(vals) || 1;
      const s = d3.scaleSequentialSqrt(metric.scheme).domain([0, max]);
      color = v => metric.zero && v <= 0 ? 'var(--panel-2)' : s(v * .85 + max * .15);
    }
    const byIdx = new Map(rows.map(r => [idx(r.date), r]));

    const el = document.getElementById('calendar');
    el.innerHTML = '';
    const svg = d3.select(el).append('svg').attr('width', W).attr('height', H).attr('role', 'img')
      .attr('aria-label', `Calendar of daily ${metric.label.toLowerCase()}`);
    ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((t, i) => t && svg.append('text').attr('x', 0).attr('y', T + i * cs + 10).text(t));
    const g = svg.append('g').attr('transform', `translate(${L},${T})`);
    const dp = unitDp(metric.group);
    const U = metric.group === 'group_percent' ? '%' : metric.group === 'group_uv' ? '' : metric.group === 'group_radiation' ? 'W/m²' : unitLabel(metric.group);
    const n = idx(last) + 1;
    const cells = d3.range(idx(first), n).map(i => ({ i, date: d3.timeDay.offset(start, i), r: byIdx.get(i) }));
    g.selectAll('rect').data(cells).join('rect')
      .attr('class', d => d.r && Number.isFinite(d.r.v) ? 'day' : 'day empty')
      .attr('x', d => Math.floor(d.i / 7) * cs).attr('y', d => (d.i % 7) * cs)
      .attr('width', cs).attr('height', cs).attr('rx', 2.5)
      .attr('fill', d => d.r && Number.isFinite(d.r.v) ? color(d.r.v) : null)
      .on('mousemove', (ev, d) => showTip(`<div class="muted">${dayFmt(d.date)}</div><b>${d.r && Number.isFinite(d.r.v) ? fmt(d.r.v, dp) + ' ' + U : 'no data'}</b>`, ev))
      .on('mouseleave', hideTip);
    // month labels + separators
    d3.timeMonths(d3.timeMonth.ceil(first), d3.timeDay.offset(last, 1))
      .forEach(mo => {
        const i = idx(mo), w = Math.floor(i / 7), dd = i % 7;
        g.append('text').attr('x', w * cs + (dd ? cs : 0)).attr('y', -6).text(d3.timeFormat(mo.getMonth() === 0 ? '%b %Y' : '%b')(mo));
        const p = dd === 0 ? `M${w * cs},0V${7 * cs}` : `M${(w + 1) * cs},0V${dd * cs}H${w * cs}V${7 * cs}`;
        g.append('path').attr('class', 'month-sep').attr('d', p);
      });

    // legend
    const leg = d3.select('#cal-legend').html('').append('svg').attr('width', 220).attr('height', 26);
    const lo = d3.min(vals), hi = d3.max(vals);
    const gradId = 'cal-grad';
    const lg = leg.append('defs').append('linearGradient').attr('id', gradId);
    d3.range(0, 1.0001, .1).forEach(t => lg.append('stop').attr('offset', t).attr('stop-color', color(metric.zero ? hi * t || 1e-9 : lo + (hi - lo) * t)));
    leg.append('rect').attr('x', 0).attr('y', 0).attr('width', 220).attr('height', 9).attr('rx', 3).attr('fill', `url(#${gradId})`);
    leg.append('text').attr('x', 0).attr('y', 22).text(`${fmt(metric.zero ? 0 : lo, dp)} ${U}`);
    leg.append('text').attr('x', 220).attr('y', 22).attr('text-anchor', 'end').text(`${fmt(hi, dp)} ${U}`);

    // summary
    const valid = rows.filter(r => Number.isFinite(r.v));
    const hiR = d3.greatest(valid, r => r.v), loR = d3.least(valid, r => r.v);
    const sd = d3.timeFormat('%e %b');
    let text;
    if (metric.key === 'rain') {
      const wet = valid.filter(r => r.v > 0.2 * (FACTORS.mm / (FACTORS[dispUnit('group_rain')] || 1))).length;
      text = `${fmt(d3.sum(valid, r => r.v), dp)} ${U} over ${valid.length} days · ${wet} wet days · wettest ${sd(hiR.date).trim()} (${fmt(hiR.v, dp)} ${U})`;
    } else {
      text = `Highest ${fmt(hiR.v, dp)} ${U} on ${sd(hiR.date).trim()} · lowest ${fmt(loR.v, dp)} ${U} on ${sd(loR.date).trim()}`;
    }
    document.getElementById('cal-summary').textContent = text;
    // keep today in view on narrow screens
    const sc = el.parentElement; sc.scrollLeft = sc.scrollWidth;
  }

  // ------------------------------------------------------------ units UI
  function buildUnitsDialog() {
    const form = document.getElementById('units-form');
    form.innerHTML = '';
    for (const [group, choices] of Object.entries(CHOICES)) {
      const src = srcUnit(group);
      if (!src) continue;
      const id = 'u-' + group;
      const lab = document.createElement('label'); lab.htmlFor = id; lab.textContent = GROUP_NAMES[group];
      const sel = document.createElement('select'); sel.id = id;
      sel.innerHTML = choices.map(u => `<option value="${u}">${UNIT_INFO[u][0]}${u === src ? ' (station)' : ''}</option>`).join('');
      sel.value = dispUnit(group);
      sel.addEventListener('change', () => {
        if (sel.value === src) delete prefs.units[group]; else prefs.units[group] = sel.value;
        store.set('units', prefs.units);
        unitsChanged();
      });
      form.append(lab, sel);
    }
  }
  function unitsChanged() {
    CARDS.forEach(c => { if (c.gauge.domainKey !== undefined) c.gauge.domainKey = ''; renderCard(c); });
    renderCalendar();
    loadForecast();
  }
  if (CONTROLS) document.getElementById('units-btn')?.addEventListener('click', () => { buildUnitsDialog(); document.getElementById('units-dialog').showModal(); });
  // Belchertown-new announces a change of its unit system with this event.
  if (!CONTROLS && CFG.unit_switcher === 'belchertown') {
    addEventListener('belchertownUnitsChanged', () => { prefs.units = hostUnits(); unitsChanged(); });
  }


  // ------------------------------------------------------ outlook ticker
  // Forecast from Open-Meteo (https://open-meteo.com, CC BY 4.0), fetched by
  // the visitor's browser: no API key, nothing to run on the WeeWX machine.
  const FORECAST = String(CFG.forecast || 'open-meteo').toLowerCase();
  const FORECAST_DAYS = Math.min(7, Math.max(1, parseInt(CFG.forecast_days, 10) || 3));
  const WMO = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorms', 96: 'Thunderstorms with hail', 99: 'Severe thunderstorms with hail'
  };
  const OM_WIND = { km_per_hour: 'kmh', mile_per_hour: 'mph', meter_per_second: 'ms', knot: 'kn' };
  const tickerBox = document.getElementById('ticker');
  const tickerTrack = document.getElementById('ticker-track');
  const tickerText = document.getElementById('ticker-text');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let tickerAnim = null, forecastTimer = null;

  function setTicker(text) {
    if (!tickerBox) return;
    tickerText.textContent = text;
    tickerBox.title = text;
    if (tickerAnim) { tickerAnim.cancel(); tickerAnim = null; }
    const boxW = tickerBox.clientWidth, textW = tickerText.offsetWidth;
    const scroll = !reduceMotion.matches && textW > boxW;
    tickerBox.classList.toggle('static', !scroll);
    if (!scroll) return;
    const pxPerSec = 55;
    tickerAnim = tickerTrack.animate(
      [{ transform: `translateX(${boxW}px)` }, { transform: `translateX(${-textW}px)` }],
      { duration: (boxW + textW) / pxPerSec * 1000, iterations: Infinity, easing: 'linear' });
  }
  let resizeTimer;
  if (tickerBox) {
    addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => setTicker(tickerText.textContent), 250); });
    tickerBox.addEventListener('mouseenter', () => tickerAnim && tickerAnim.pause());
    tickerBox.addEventListener('mouseleave', () => tickerAnim && tickerAnim.play());
  }

  async function loadForecast() {
    clearTimeout(forecastTimer);
    if (!tickerBox) return;          // no ticker on this page: nothing to fetch
    if (FORECAST === 'none' || FORECAST === 'false' || FORECAST === 'off') { setTicker(CFG.ticker_text || ''); return; }
    const st = state.rt?.station || {};
    const lat = Number(st.latitude), lon = Number(st.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
      setTicker('Outlook not available: set latitude and longitude in the [Station] section of weewx.conf');
      return;
    }
    const tU = dispUnit('group_temperature') === 'degree_F' ? 'fahrenheit' : 'celsius';
    const wU = OM_WIND[dispUnit('group_speed')] || 'kmh';
    const rU = dispUnit('group_rain') === 'inch' ? 'inch' : 'mm';
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'auto', forecast_days: FORECAST_DAYS,
      current: 'weather_code,temperature_2m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant',
      temperature_unit: tU, wind_speed_unit: wU, precipitation_unit: rU
    });
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      setTicker(describeForecast(await r.json()));
      forecastTimer = setTimeout(loadForecast, 30 * 60 * 1000);
    } catch (e) {
      setTicker('Forecast is not available');
      forecastTimer = setTimeout(loadForecast, 5 * 60 * 1000);
    }
  }

  function describeForecast(f) {
    const d = f.daily || {}, u = f.daily_units || {};
    const deg = u.temperature_2m_max || '°';
    const wind = (u.wind_speed_10m_max || '').replace('km/h', 'km/h');
    const rainU = u.precipitation_sum || '';
    const parts = [];
    if (f.current && WMO[f.current.weather_code] != null) parts.push(`Now: ${WMO[f.current.weather_code]}`);
    (d.time || []).forEach((day, i) => {
      const [y, m, dd] = day.split('-').map(Number);
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d3.timeFormat('%A')(new Date(y, m - 1, dd));
      const bits = [WMO[d.weather_code?.[i]] || 'Unsettled'];
      const hi = d.temperature_2m_max?.[i], lo = d.temperature_2m_min?.[i];
      if (hi != null && lo != null) bits.push(`high ${Math.round(hi)}${deg}, low ${Math.round(lo)}${deg}`);
      const pp = d.precipitation_probability_max?.[i], ps = d.precipitation_sum?.[i];
      if (pp != null && pp >= 10) bits.push(`${pp}% chance of rain` + (ps ? ` (${fmt(ps, rainU === 'inch' ? 2 : 1)} ${rainU})` : ''));
      const ws = d.wind_speed_10m_max?.[i], wd = d.wind_direction_10m_dominant?.[i];
      if (ws != null) bits.push(`wind ${wd != null ? compass(wd) + ' ' : ''}${Math.round(ws)} ${wind}`);
      parts.push(`${label}: ${bits.join(', ')}`);
    });
    parts.push('Forecast by Open-Meteo.com');
    return parts.join('   •   ');
  }

  // ------------------------------------------------------- live over MQTT
  // On a Belchertown-new page whose live updates come over MQTT (its
  // mqtt_websockets_* settings, passed in as CFG.mqtt), the gauges take their
  // current readings from the same broker the moment each LOOP packet is
  // published. realtime.json still supplies what MQTT doesn't carry (wind
  // average, gust and rose, rain hour/month/year, pressure trend, the day's
  // highs and lows) and is read less often while MQTT is live. Without MQTT,
  // or whenever it stops, realtime.json is the live source as usual.
  // Packets are those of the weewx-mqtt uploader: keys carry their unit,
  // e.g. outTemp_C, windSpeed_kph, barometer_mbar, dayRain_cm.
  const MQTT = CFG.mqtt && CFG.mqtt.host ? CFG.mqtt : null;
  const MQTT_STALE_MS = 120000;           // no packet for this long: MQTT isn't live
  const SLOW_POLL_MS = 60000;             // realtime.json while MQTT is live
  const MQTT_UNIT = {
    C: 'degree_C', F: 'degree_F', degree_C: 'degree_C', degree_F: 'degree_F',
    mbar: 'mbar', hPa: 'hPa', kPa: 'kPa', inHg: 'inHg', mmHg: 'mmHg',
    mm: 'mm', cm: 'cm', in: 'inch', inch: 'inch',
    mm_per_hour: 'mm_per_hour', cm_per_hour: 'cm_per_hour', in_per_hour: 'inch_per_hour', inch_per_hour: 'inch_per_hour',
    mps: 'meter_per_second', meter_per_second: 'meter_per_second', kph: 'km_per_hour', km_per_hour: 'km_per_hour',
    mph: 'mile_per_hour', mile_per_hour: 'mile_per_hour', knot: 'knot', knot2: 'knot',
    meter: 'meter', foot: 'foot', km: 'km', mile: 'mile', Wpm2: 'watt_per_meter_squared'
  };
  // Packets without unit labels use the unit system in their usUnits field.
  const US_UNITS = {
    1: { group_temperature: 'degree_F', group_pressure: 'inHg', group_speed: 'mile_per_hour', group_rain: 'inch', group_rainrate: 'inch_per_hour', group_altitude: 'foot' },
    16: { group_temperature: 'degree_C', group_pressure: 'mbar', group_speed: 'km_per_hour', group_rain: 'cm', group_rainrate: 'cm_per_hour', group_altitude: 'meter' },
    17: { group_temperature: 'degree_C', group_pressure: 'mbar', group_speed: 'meter_per_second', group_rain: 'mm', group_rainrate: 'mm_per_hour', group_altitude: 'meter' }
  };
  const mqttState = { packet: {}, ts: 0, lastMsg: 0, client: null, retry: 0, rendered: 0, renderTimer: null };
  const mqttLive = () => !!MQTT && Date.now() - mqttState.lastMsg < MQTT_STALE_MS;
  const groupOf = obs => obs === 'dayRain' || obs === 'hourRain' || obs === 'rain24' ? 'group_rain'
    : OBS_GROUP[obs] || state.rt?.obsGroups?.[obs] || null;

  // One packet value as [obs, value in the gauges' own units], or null.
  function mqttValue(key, raw, usUnits) {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return null;
    let obs = key, from = null;
    const i = key.indexOf('_');
    if (i > 0) { obs = key.slice(0, i); from = MQTT_UNIT[key.slice(i + 1)]; if (!from) return null; }
    const group = groupOf(obs);
    if (!group) return null;
    if (!from) from = FIXED_UNIT[group] || US_UNITS[usUnits]?.[group];
    if (!from) return null;                       // a measurement with no known unit
    // weewx-mqtt sends full precision (wind 0.0000028 km/h): round like realtime.json.
    return [obs, Math.round(convertUnit(v, from, srcUnit(group) || from) * 1000) / 1000];
  }

  // Overlay the latest MQTT readings on the realtime data. The day's highs
  // and lows stretch to include them.
  function applyMqtt(rt) {
    if (!mqttState.ts || mqttState.ts < (rt.dateTime || 0)) return;
    const usUnits = parseInt(mqttState.packet.usUnits, 10);
    rt.current = rt.current || {}; rt.day = rt.day || {};
    for (const [key, raw] of Object.entries(mqttState.packet)) {
      const kv = mqttValue(key, raw, usUnits);
      if (!kv) continue;
      const [obs, v] = kv;
      if (obs === 'dayRain') { (rt.rain = rt.rain || {}).day = v; continue; }
      if (obs === 'rain' || obs === 'hourRain' || obs === 'rain24') continue;
      rt.current[obs] = v;
      const d = rt.day[obs] || (rt.day[obs] = {});
      if (!(d.max >= v)) { d.max = v; d.maxtime = mqttState.ts; }
      if (!(d.min <= v)) { d.min = v; d.mintime = mqttState.ts; }
    }
    if (rt.current.windGust > (rt.day.windGust?.max ?? -Infinity)) {
      rt.day.windGust = Object.assign(rt.day.windGust || {}, { max: rt.current.windGust, maxtime: mqttState.ts });
    }
    rt.dateTime = mqttState.ts;
  }

  // Before realtime.json has arrived (or where it isn't published), start
  // from the MQTT packet alone, in the host page's units.
  function mqttSkeleton() {
    const base = US_UNITS[parseInt(mqttState.packet.usUnits, 10)] || US_UNITS[17];
    const units = {};
    for (const g of Object.keys(base)) units[g] = { unit: (CFG.display_units || {})[g] || base[g] };
    if (units.group_rain && !(CFG.display_units || {}).group_rainrate) units.group_rainrate = { unit: RATE_OF[units.group_rain.unit] || base.group_rainrate };
    return { dateTime: 0, units, current: {}, day: {}, obsGroups: {}, mqttOnly: true };
  }

  function onMqttPacket(text) {
    let p;
    try { p = JSON.parse(text); } catch (e) { return; }
    if (!p || typeof p !== 'object' || 'interval_minute' in p || 'interval' in p) return;   // archive records: averages, not live
    const ts = parseFloat(p.dateTime);
    if (!Number.isFinite(ts) || ts < mqttState.ts) return;
    Object.assign(mqttState.packet, p);            // packets may carry only some readings
    mqttState.ts = ts;
    mqttState.lastMsg = Date.now();
    if (!state.rt) { state.rt = mqttSkeleton(); serverUnits = state.rt.units; }
    applyMqtt(state.rt);
    // At most one redraw a second, however fast the station sends.
    if (!mqttState.renderTimer) {
      mqttState.renderTimer = setTimeout(() => {
        mqttState.renderTimer = null;
        mqttState.drawnAt = Date.now();
        const first = !mqttState.rendered++;
        recordLive(state.rt);
        state.serverAge = Math.max(0, Date.now() / 1000 - state.rt.dateTime); state.fetchedAt = Date.now();
        CARDS.forEach(renderCard);
        if (first && !lastJsonTs) renderCalendar();
        setStatus();
      }, Math.max(0, 1000 - (Date.now() - (mqttState.drawnAt || 0))));
    }
  }

  function mqttConnect(tries = 0) {
    if (!window.Paho || typeof window.Paho.Client !== 'function') {
      // Paho loads with defer; give up after ~15 s and stay on realtime.json.
      if (tries < 30) setTimeout(() => mqttConnect(tries + 1), 500);
      return;
    }
    const id = 'carbonsteel' + Math.floor(Math.random() * 1e9);
    const client = new window.Paho.Client(MQTT.host, Number(MQTT.port) || 1883, id);
    mqttState.client = client;
    const retry = () => {
      const wait = Math.min(60000, 5000 * 2 ** Math.min(mqttState.retry++, 4));
      setTimeout(() => { if (!document.hidden) mqttConnect(30); }, wait);
    };
    client.onConnectionLost = () => { mqttState.client = null; mqttLost(); if (!document.hidden) retry(); };
    client.onMessageArrived = m => onMqttPacket(m.payloadString);
    const opts = {
      useSSL: !!MQTT.ssl, mqttVersion: 4, mqttVersionExplicit: false, reconnect: false, timeout: 10,
      onSuccess: () => { mqttState.retry = 0; client.subscribe(MQTT.topic || '#'); },
      onFailure: () => { mqttState.client = null; mqttLost(); retry(); }
    };
    if (MQTT.username) { opts.userName = MQTT.username; if (MQTT.password) opts.password = MQTT.password; }
    try { client.connect(opts); } catch (e) { mqttState.client = null; retry(); }
  }
  // MQTT gone (connection lost, or no packets for a while): go straight back
  // to reading realtime.json at the normal rate rather than at the next slow read.
  function mqttLost() {
    if (!mqttState.lastMsg) return;
    mqttState.lastMsg = 0;
    if (!document.hidden) poll();
  }
  if (MQTT) {
    setInterval(() => { if (mqttState.lastMsg && !mqttLive()) mqttLost(); }, 10000);
    // Like Belchertown, let go of the broker in a background tab, and come back.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { try { mqttState.client?.disconnect(); } catch (e) { /* already closed */ } mqttState.client = null; }
      else if (!mqttState.client) mqttConnect(30);
    });
  }

  // ------------------------------------------------------------- polling
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const ageNum = document.getElementById('age-num');
  const ageUnit = document.getElementById('age-unit');
  const led = statusEl?.querySelector('.led');
  let failures = 0, timer = null, lastTs = 0, lastJsonTs = 0;

  function setStatus() {
    if (!statusEl) return;
    const rt = state.rt;
    if (!rt) { statusEl.dataset.state = failures ? 'offline' : 'connecting'; statusText.textContent = failures ? 'No realtime data' : 'Connecting…'; return; }
    const age = state.serverAge + (Date.now() - state.fetchedAt) / 1000;
    const when = hhmmss(new Date(rt.dateTime * 1000));
    const secs = Math.max(0, Math.floor(age));
    if (secs < 1000) { ageNum.textContent = secs; ageUnit.textContent = secs === 1 ? 'second' : 'seconds'; }
    else if (secs < 360000) { ageNum.textContent = Math.floor(secs / 60); ageUnit.textContent = 'minutes'; }
    else { ageNum.textContent = Math.floor(secs / 3600); ageUnit.textContent = 'hours'; }
    if (failures > 2) { statusEl.dataset.state = 'offline'; statusText.textContent = `Offline · last ${when}`; }
    else if (age > STALE_S) { statusEl.dataset.state = 'stale'; statusText.textContent = `Station quiet · last ${when}`; }
    else { statusEl.dataset.state = 'live'; statusText.textContent = `Live · ${when}`; }
  }
  setInterval(setStatus, 1000);

  async function poll() {
    clearTimeout(timer);
    try {
      const res = await fetch(REALTIME_URL + (REALTIME_URL.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const rt = await res.json();
      const serverNow = Date.parse(res.headers.get('Date') || '') || Date.now();
      state.serverAge = Math.max(0, serverNow / 1000 - rt.dateTime);
      state.fetchedAt = Date.now();
      failures = 0;
      const fresh = rt.dateTime !== lastJsonTs;
      lastJsonTs = rt.dateTime;
      const firstTime = !state.rt || state.rt.mqttOnly;
      if (MQTT) { serverUnits = rt.units || {}; applyMqtt(rt); }   // newer MQTT readings win
      if (fresh || rt.dateTime !== lastTs) {
        lastTs = rt.dateTime;
        if (led) { led.classList.remove('blink'); void led.offsetWidth; led.classList.add('blink'); }
        state.rt = rt;
        serverUnits = rt.units || {};
        recordLive(rt);
        const nameEl = document.getElementById('station-name');
        if (!CFG.title && rt.station?.location && firstTime && nameEl) nameEl.textContent = rt.station.location;
        CARDS.forEach(renderCard);
        if (firstTime) { renderCalendar(); loadForecast(); }
      }
    } catch (e) {
      failures++;
    }
    setStatus();
    const every = mqttLive() ? Math.max(POLL_MS, SLOW_POLL_MS) : POLL_MS;
    const delay = failures ? Math.min(mqttLive() ? SLOW_POLL_MS : 30000, every * 2 ** Math.min(failures, 4)) : every;
    if (!document.hidden) timer = setTimeout(poll, delay);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); else clearTimeout(timer); });

  async function loadJson(url) {
    const r = await fetch(url + '?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }
  async function loadHistory() {
    if (!SHOW_SPARKS) return;
    try { state.history = await loadJson(dataUrl('history.json')); } catch (e) { /* first run */ }
    CARDS.forEach(renderCard);
  }
  async function loadCalendar() {
    if (!SHOW_CALENDAR) return;
    try { state.calendar = await loadJson(dataUrl('calendar.json')); } catch (e) { /* first run */ }
    if (state.rt) renderCalendar();
  }

  if (CFG.title && CONTROLS) { document.getElementById('station-name').textContent = CFG.title; document.title = CFG.title + ' · Live gauges'; }
  buildCards();
  buildLookMenu('face');
  buildLookMenu('bezel');
  applyLook();
  if (HOST_THEME) {
    // Re-draw faces and bezels when the host page switches light/dark.
    const mo = new MutationObserver(() => applyLook());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme', 'class'] });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  poll();
  if (MQTT) mqttConnect();
  loadHistory();
  loadCalendar();
  setInterval(loadHistory, 5 * 60 * 1000);
  setInterval(loadCalendar, 60 * 60 * 1000);
})();
