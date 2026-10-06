/* =====================================================================
   BENSON LIFE OS v1.0 — Hyperbolic Life Map
   ---------------------------------------------------------------------
   A focus + context life map on a Poincaré disk, written from scratch in
   plain JavaScript + SVG (no framework, no build step, no runtime deps).

   How the map works (short version):
   1. Layout   — every node gets a position in the hyperbolic plane:
                 depth d  -> hyperbolic radius d * LEVEL_STEP,
                 subtree  -> angular wedge proportional to its size.
                 Stored as a point inside the unit disk (Poincaré model).
   2. Focus    — the view is a Möbius translation T_c(z) = (z - c)/(1 - c̄z)
                 that moves point c to the center. Focusing a node animates
                 c along the hyperbolic geodesic toward that node.
   3. Context  — points far from the focus shrink toward the disk edge but
                 never disappear, so the whole life stays in view.
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 1. Constants and state                                              */
  /* ------------------------------------------------------------------ */

  const PUBLIC_URL = 'data/public-data.json';
  const PREFS_KEY = 'blos.prefs.v1';
  const DECISION_KEY = 'blos.decision.v1';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const LEVEL_STEP = 1.15;     // hyperbolic distance between tree levels
  const ANIM_MS = 750;         // focus animation duration
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 4;
  const DRAG_THRESHOLD = 5;    // px before a press becomes a drag
  const DBLCLICK_MS = 350;
  const OPTION_COLORS = ['#4F7FD9', '#2E9DB3', '#8873D0', '#D2874E', '#B49A3E', '#C8625A', '#4FA47F'];

  const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const DEFAULT_PREFS = {
    theme: null,          // 'dark' | 'light' | null (follow system)
    labels: true,
    links: 'focus',       // 'off' (hover only) | 'focus' | 'all'
    rings: true,          // progress rings
    focusMode: false,
    view: 'map',
    panelOpen: null,      // null = decide by screen width
    lastFocus: 'self',
    filters: { categories: [], statuses: [], priorities: [] }
  };

  const state = {
    publicData: null,
    privateData: null,
    privateSource: '',     // 'auto' | 'file'
    privateTried: false,
    privateMode: false,    // never persisted: always starts off (safe for screen sharing)
    model: null,           // { byId, list, root, related }
    searchIndex: [],
    focusId: 'self',
    center: [0, 0],        // current Möbius translation point (disk coords)
    anim: null,
    zoom: 1,
    size: { w: 0, h: 0 },
    baseR: 100,
    history: [],
    forward: [],
    hoverId: null,
    highlightId: null,
    highlightTimer: null,
    linkPairs: [],
    renderQueued: false,
    prefs: null,
    lastClick: { id: null, t: 0 },
    pointer: null,         // active drag info
    pointers: new Map(),   // active pointers (for pinch)
    pinch: null,
    searchSel: -1,
    searchResults: []
  };

  const el = {};           // cached DOM references
  const mapEls = {};       // SVG groups

  /* ------------------------------------------------------------------ */
  /* 2. Small utilities                                                  */
  /* ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isNum = (v) => typeof v === 'number' && isFinite(v);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function svgEl(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach((k) => node.setAttribute(k, attrs[k]));
    if (parent) parent.appendChild(node);
    return node;
  }

  function deepClone(obj) {
    return obj == null ? obj : JSON.parse(JSON.stringify(obj));
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /* localStorage access never throws (private windows, blocked storage). */
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function loadPrefs() {
    const prefs = deepClone(DEFAULT_PREFS);
    try {
      const saved = JSON.parse(storageGet(PREFS_KEY) || '{}');
      if (saved && typeof saved === 'object') {
        Object.keys(DEFAULT_PREFS).forEach((k) => {
          if (k === 'filters') return;
          if (saved[k] !== undefined) prefs[k] = saved[k];
        });
        if (saved.filters && typeof saved.filters === 'object') {
          ['categories', 'statuses', 'priorities'].forEach((k) => {
            if (Array.isArray(saved.filters[k])) prefs.filters[k] = saved.filters[k].filter((x) => typeof x === 'string');
          });
        }
      }
    } catch (e) { /* corrupted prefs: use defaults */ }
    if (['off', 'focus', 'all'].indexOf(prefs.links) < 0) prefs.links = 'focus';
    if (['map', 'timeline', 'balance', 'decision'].indexOf(prefs.view) < 0) prefs.view = 'map';
    return prefs;
  }

  function savePrefs() {
    storageSet(PREFS_KEY, JSON.stringify(state.prefs));
  }

  let toastTimer = null;
  function toast(message, ms) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms || 3600);
  }

  /* ------------------------------------------------------------------ */
  /* 3. Hyperbolic geometry (complex numbers as [x, y])                  */
  /* ------------------------------------------------------------------ */

  /** Möbius translation T_c(z) = (z - c) / (1 - conj(c) z). Moves c to 0. */
  function mobius(z, c) {
    const nx = z[0] - c[0];
    const ny = z[1] - c[1];
    const dx = 1 - (c[0] * z[0] + c[1] * z[1]);
    const dy = -(c[0] * z[1] - c[1] * z[0]);
    const den = dx * dx + dy * dy || 1e-12;
    return [(nx * dx + ny * dy) / den, (ny * dx - nx * dy) / den];
  }

  function norm(z) { return Math.sqrt(z[0] * z[0] + z[1] * z[1]); }

  function atanh(x) { return 0.5 * Math.log((1 + x) / (1 - x)); }

  /** Keep a point safely inside the unit disk. */
  function clampDisk(z, max) {
    const r = norm(z);
    const m = max || 0.985;
    return r > m ? [z[0] * m / r, z[1] * m / r] : z;
  }

  /**
   * SVG path for the hyperbolic geodesic between display points a and b.
   * In the frame where a is at the origin, the geodesic is a straight
   * line; sample it there and map back.
   */
  function geodesicPath(a, b, R, segments) {
    const seg = segments || 12;
    const u = mobius(b, a);
    const back = [-a[0], -a[1]];
    let d = 'M' + (a[0] * R).toFixed(1) + ',' + (a[1] * R).toFixed(1);
    for (let i = 1; i <= seg; i++) {
      const t = i / seg;
      const p = mobius([u[0] * t, u[1] * t], back);
      d += 'L' + (p[0] * R).toFixed(1) + ',' + (p[1] * R).toFixed(1);
    }
    return d;
  }

  /* ------------------------------------------------------------------ */
  /* 4. Data loading                                                     */
  /* ------------------------------------------------------------------ */

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  /** Validate and fill defaults so the rest of the app can trust the data. */
  function normalizePublicData(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.nodes) || !data.nodes.length) {
      throw new Error('File does not contain a "nodes" array.');
    }
    data.meta = data.meta || {};
    data.settings = data.settings || {};
    const s = data.settings;
    s.categories = Array.isArray(s.categories) ? s.categories : [];
    s.statuses = Array.isArray(s.statuses) && s.statuses.length ? s.statuses : [
      { id: 'idea', name: 'Idea' }, { id: 'exploring', name: 'Exploring' }, { id: 'planning', name: 'Planning' },
      { id: 'active', name: 'Active' }, { id: 'waiting', name: 'Waiting' }, { id: 'completed', name: 'Completed' },
      { id: 'paused', name: 'Paused' }, { id: 'dropped', name: 'Dropped' }
    ];
    s.priorities = Array.isArray(s.priorities) && s.priorities.length ? s.priorities : [
      { id: 'P1', name: 'P1 Critical' }, { id: 'P2', name: 'P2 High' }, { id: 'P3', name: 'P3 Medium' }, { id: 'P4', name: 'P4 Low' }
    ];
    s.reflectionPrompts = s.reflectionPrompts || {};
    s.balanceCategories = Array.isArray(s.balanceCategories) ? s.balanceCategories : [];
    data.timeline = Array.isArray(data.timeline) ? data.timeline : [];
    data.decision = data.decision && typeof data.decision === 'object' ? data.decision : null;
    return data;
  }

  function showLoader(message, withPicker) {
    el.loader.hidden = false;
    el.loaderMessage.textContent = message;
    el.loaderActions.hidden = !withPicker;
  }

  function hideLoader() {
    el.loader.hidden = true;
  }

  function readFileAsJson(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(JSON.parse(String(reader.result))); }
        catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
      };
      reader.onerror = () => reject(new Error('Could not read file.'));
      reader.readAsText(file);
    });
  }

  /**
   * Private data is never fetched on page load, so a missing file never
   * produces a network error. Two ways to load it:
   *   1. Settings › Load private-data.json… (any host; memory only).
   *   2. Opt-in auto-load: set settings.privateData.autoLoad = true in
   *      public-data.json; then turning on Private Mode on an allowed host
   *      (default: localhost) fetches data/private-data.json once.
   */
  async function tryAutoLoadPrivate() {
    const cfg = (state.publicData.settings.privateData) || {};
    if (cfg.autoLoad !== true) return false;
    const hosts = Array.isArray(cfg.autoLoadHosts) ? cfg.autoLoadHosts : ['localhost', '127.0.0.1'];
    if (!/^https?:$/.test(location.protocol) || hosts.indexOf(location.hostname) < 0) return false;
    try {
      const data = await fetchJson(cfg.url || 'data/private-data.json');
      setPrivateData(data, 'auto');
      return true;
    } catch (e) {
      return false;
    }
  }

  function setPrivateData(data, source) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Private data must be a JSON object.');
    }
    state.privateData = data;
    state.privateSource = source;
    updatePrivateUi();
  }

  /* ------------------------------------------------------------------ */
  /* 5. Model: merge data, build the tree and the relation graph         */
  /* ------------------------------------------------------------------ */

  function categoryInfo(id) {
    const cats = state.publicData.settings.categories;
    for (let i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i];
    return { id: id || 'other', name: id || 'Other', color: '#7D8A94' };
  }

  function statusName(id) {
    const s = state.publicData.settings.statuses.find((x) => x.id === id);
    return s ? s.name : (id || '—');
  }

  function priorityName(id) {
    const p = state.publicData.settings.priorities.find((x) => x.id === id);
    return p ? p.name : (id || '—');
  }

  function buildModel() {
    const pub = state.publicData;
    const usePrivate = state.privateMode;

    let list = pub.nodes
      .filter((n) => n && typeof n.id === 'string' && n.id)
      .map((n) => Object.assign({}, n));
    if (!usePrivate) list = list.filter((n) => !n.private);

    // Merge private overlay (overrides + extra nodes) only in Private Mode.
    if (usePrivate && state.privateData) {
      const pd = state.privateData;
      const overrides = pd.overrides && typeof pd.overrides === 'object' ? pd.overrides : {};
      list.forEach((n) => {
        const ov = overrides[n.id];
        if (ov && typeof ov === 'object') {
          const copy = Object.assign({}, ov);
          delete copy.id;
          delete copy.parent;
          Object.assign(n, copy);
          n.hasPrivate = true;
        }
      });
      (Array.isArray(pd.nodes) ? pd.nodes : []).forEach((n) => {
        if (n && typeof n.id === 'string' && n.id) list.push(Object.assign({}, n, { private: true, privateNode: true }));
      });
    }

    // Index (first occurrence of an id wins; duplicates are ignored).
    const byId = new Map();
    list.forEach((n) => {
      if (byId.has(n.id)) { console.warn('[Life OS] Duplicate node id ignored:', n.id); return; }
      byId.set(n.id, n);
    });
    list = Array.from(byId.values());

    const root = byId.get('self') || list.find((n) => !n.parent) || list[0];

    // Resolve parents. Missing parents and cycles fall back to the root.
    list.forEach((n) => {
      n.children = [];
      if (n === root) { n._p = null; return; }
      n._p = (n.parent && n.parent !== n.id && byId.has(n.parent)) ? n.parent : root.id;
      if (n._p === root.id && n.parent && n.parent !== root.id) {
        console.warn('[Life OS] Parent "' + n.parent + '" not found for "' + n.id + '"; attached to root.');
      }
    });
    list.forEach((n) => {
      const seen = new Set();
      let cur = n;
      while (cur && cur._p) {
        if (seen.has(cur.id)) { n._p = root.id; break; }
        seen.add(cur.id);
        cur = byId.get(cur._p);
      }
    });
    list.forEach((n) => { if (n._p) byId.get(n._p).children.push(n); });

    // Depth via DFS from root.
    (function setDepth(n, d) {
      n.depth = d;
      n.children.forEach((c) => setDepth(c, d + 1));
    })(root, 0);

    // Undirected secondary relations.
    const related = new Map();
    list.forEach((n) => related.set(n.id, new Set()));
    list.forEach((n) => {
      (Array.isArray(n.related) ? n.related : []).forEach((r) => {
        if (r !== n.id && byId.has(r)) {
          related.get(n.id).add(r);
          related.get(r).add(n.id);
        }
      });
    });

    // Colors.
    list.forEach((n) => { n.color = categoryInfo(n.category).color; });

    return { byId: byId, list: list, root: root, related: related };
  }

  function pathTo(node) {
    const path = [];
    let cur = node;
    while (cur) {
      path.unshift(cur);
      cur = cur._p ? state.model.byId.get(cur._p) : null;
    }
    return path;
  }

  function neighborhood(id) {
    const m = state.model;
    const set = new Set();
    const node = m.byId.get(id);
    if (!node) return set;
    pathTo(node).forEach((n) => set.add(n.id));
    node.children.forEach((c) => set.add(c.id));
    m.related.get(id).forEach((r) => set.add(r));
    return set;
  }

  /* ------------------------------------------------------------------ */
  /* 6. Layout in the hyperbolic plane                                   */
  /* ------------------------------------------------------------------ */

  function layoutTree(root) {
    (function weigh(n) {
      n._weight = n.children.length ? n.children.reduce((s, c) => s + weigh(c), 0) : 1;
      return n._weight;
    })(root);

    root.pos = [0, 0];
    root.rho = 0;

    function place(n, a0, a1) {
      const kids = n.children;
      if (!kids.length) return;
      // Compress weights so large branches do not starve small ones.
      const ws = kids.map((c) => Math.pow(c._weight, 0.7));
      const total = ws.reduce((s, w) => s + w, 0);
      let a = a0;
      kids.forEach((c, i) => {
        const span = (a1 - a0) * ws[i] / total;
        c.angle = a + span / 2;
        c.rho = n.rho + LEVEL_STEP;
        const r = Math.tanh(c.rho / 2);   // hyperbolic radius -> Poincaré radius
        c.pos = [r * Math.cos(c.angle), r * Math.sin(c.angle)];
        place(c, a, a + span);
        a += span;
      });
    }

    // Start so the first branch sits at 12 o'clock.
    const firstW = root.children.length ? Math.pow(root.children[0]._weight, 0.7) : 1;
    const totalW = root.children.reduce((s, c) => s + Math.pow(c._weight, 0.7), 0) || 1;
    const start = -Math.PI / 2 - Math.PI * firstW / totalW;
    place(root, start, start + 2 * Math.PI);
  }

  /* ------------------------------------------------------------------ */
  /* 7. Map rendering                                                    */
  /* ------------------------------------------------------------------ */

  function statusStyle(status) {
    switch (status) {
      case 'idea': case 'exploring': case 'planning': return 'hollow';
      case 'waiting': case 'paused': return 'muted';
      case 'dropped': return 'dropped';
      default: return 'filled';
    }
  }

  function buildMapDom() {
    const svg = el.map;
    svg.textContent = '';
    const vp = svgEl('g', { class: 'viewport' }, svg);
    mapEls.viewport = vp;
    mapEls.disk = svgEl('circle', { class: 'disk', cx: 0, cy: 0, r: 100 }, vp);
    mapEls.guide = svgEl('circle', { class: 'disk-guide', cx: 0, cy: 0, r: 50 }, vp);
    mapEls.edges = svgEl('g', { class: 'edges' }, vp);
    mapEls.links = svgEl('g', { class: 'links' }, vp);
    mapEls.nodes = svgEl('g', { class: 'nodes' }, vp);
    mapEls.labels = svgEl('g', { class: 'labels' }, vp);

    const m = state.model;
    // Draw deep nodes first so shallow nodes sit on top.
    const ordered = m.list.slice().sort((a, b) => b.depth - a.depth);

    ordered.forEach((n) => {
      if (n._p) n.edgeEl = svgEl('path', { class: 'edge' }, mapEls.edges);

      const g = svgEl('g', {
        class: 'node' + (n === m.root ? ' is-root' : ''),
        'data-id': n.id,
        role: 'button',
        tabindex: '-1',
        'aria-label': n.name + (n.status ? ', ' + statusName(n.status) : '')
      }, mapEls.nodes);
      n.haloEl = svgEl('circle', { class: 'halo', r: 10 }, g);
      n.ringEl = svgEl('circle', { class: 'ring', r: 10, transform: 'rotate(-90)' }, g);
      const dot = svgEl('circle', { class: 'dot', r: 6 }, g);
      const style = statusStyle(n.status);
      if (n !== m.root) {
        dot.setAttribute('stroke', n.color);
        if (style === 'hollow') {
          dot.setAttribute('fill', 'var(--disk)');
        } else if (style === 'muted') {
          dot.setAttribute('fill', n.color);
          dot.setAttribute('fill-opacity', '0.35');
        } else if (style === 'dropped') {
          dot.setAttribute('fill', 'var(--disk)');
          dot.setAttribute('stroke-dasharray', '2 2');
        } else {
          dot.setAttribute('fill', n.color);
        }
      }
      n.el = g;
      n.dotEl = dot;

      const label = svgEl('text', { class: 'label' + (n === m.root ? ' is-root' : '') }, mapEls.labels);
      if (n === m.root && n.subtitle) {
        const t1 = svgEl('tspan', {}, label);
        t1.textContent = n.name;
        const t2 = svgEl('tspan', { class: 'label-sub' }, label);
        t2.textContent = n.subtitle;
        n.labelLines = [t1, t2];
      } else {
        label.textContent = n.name;
      }
      n.labelEl = label;
    });
  }

  function requestRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    window.requestAnimationFrame(() => {
      state.renderQueued = false;
      renderMap();
    });
  }

  function renderMap() {
    const m = state.model;
    if (!m || !mapEls.viewport) return;
    const W = state.size.w;
    const H = state.size.h;
    if (W < 10 || H < 10) return;

    const R = state.baseR * state.zoom;
    const sizeScale = Math.sqrt(state.zoom);
    mapEls.viewport.setAttribute('transform', 'translate(' + (W / 2) + ',' + (H / 2) + ')');
    mapEls.disk.setAttribute('r', R.toFixed(1));
    mapEls.guide.setAttribute('r', (R * Math.tanh(LEVEL_STEP / 2)).toFixed(1));

    const c = state.center;
    const focus = m.byId.get(state.focusId) || m.root;

    // Project nodes.
    m.list.forEach((n) => {
      const w = mobius(n.pos, c);
      const s = 1 - (w[0] * w[0] + w[1] * w[1]);   // ~ local hyperbolic scale
      n._w = w;
      n._s = s;
      n._x = w[0] * R;
      n._y = w[1] * R;
      n._visible = s > 0.004;

      let base = n === m.root ? 11 : n.depth === 1 ? 8 : n.depth === 2 ? 6 : 5;
      if (n.priority === 'P1') base += 1;
      if (n === focus) base = Math.max(base, 10);
      n._r = Math.max(1.2, base * (0.22 + 0.78 * Math.max(0, s)) * sizeScale);

      const fade = clamp((s - 0.004) / 0.06, 0, 1);
      n._op = fade * (n._dim ? 0.18 : 1);

      if (!n._visible) {
        n.el.setAttribute('display', 'none');
        return;
      }
      n.el.removeAttribute('display');
      n.el.setAttribute('transform', 'translate(' + n._x.toFixed(1) + ',' + n._y.toFixed(1) + ')');
      n.el.setAttribute('opacity', n._op.toFixed(3));
      n.dotEl.setAttribute('r', n._r.toFixed(2));
      n.haloEl.setAttribute('r', (n._r + 4).toFixed(2));

      // Progress ring (personal indicator, not a measurement).
      if (state.prefs.rings && isNum(n.progress) && s > 0.3 && n._r > 3.5) {
        const rr = n._r + 2.5;
        const circ = 2 * Math.PI * rr;
        const p = clamp(n.progress, 0, 100) / 100;
        n.ringEl.removeAttribute('display');
        n.ringEl.setAttribute('r', rr.toFixed(2));
        n.ringEl.setAttribute('stroke-dasharray', (circ * p).toFixed(2) + ' ' + circ.toFixed(2));
      } else {
        n.ringEl.setAttribute('display', 'none');
      }
    });

    // Tree edges as geodesic arcs.
    m.list.forEach((n) => {
      if (!n.edgeEl) return;
      const p = m.byId.get(n._p);
      const sMin = Math.min(n._s, p._s);
      if (sMin < 0.004) { n.edgeEl.setAttribute('display', 'none'); return; }
      n.edgeEl.removeAttribute('display');
      n.edgeEl.setAttribute('d', geodesicPath(p._w, n._w, R, sMin > 0.3 ? 12 : 6));
      n.edgeEl.setAttribute('stroke-width', (0.5 + 1.1 * sMin).toFixed(2));
      const op = clamp((sMin - 0.004) / 0.06, 0, 1) * ((n._dim || p._dim) ? 0.2 : 0.9);
      n.edgeEl.setAttribute('opacity', op.toFixed(3));
    });

    // Secondary relationship links.
    state.linkPairs.forEach((pair) => {
      const a = m.byId.get(pair.a);
      const b = m.byId.get(pair.b);
      if (!a || !b || Math.min(a._s, b._s) < 0.004) { pair.el.setAttribute('display', 'none'); return; }
      pair.el.removeAttribute('display');
      pair.el.setAttribute('d', geodesicPath(a._w, b._w, R, 16));
    });

    renderLabels(focus, R);
  }

  /** Greedy label placement: important labels first, skip overlaps. */
  function renderLabels(focus, R) {
    const m = state.model;
    const showAll = state.prefs.labels;
    const focusSet = state.focusNeighborhood || new Set();
    const items = [];

    m.list.forEach((n) => {
      const special = n === focus || n === m.root || n.id === state.hoverId || n.id === state.highlightId;
      let score = n._s * 100 - n.depth * 3;
      if (focusSet.has(n.id)) score += 300;
      if (n === m.root) score += 900;
      if (n === focus) score += 1000;
      if (n.id === state.hoverId || n.id === state.highlightId) score += 950;
      if (n._dim) score -= 200;
      items.push({ n: n, special: special, score: score });
    });
    items.sort((a, b) => b.score - a.score);

    const placed = [];
    const overlaps = (box) => placed.some((p) =>
      box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0);

    items.forEach((it) => {
      const n = it.n;
      const label = n.labelEl;
      const hide = () => label.setAttribute('display', 'none');

      if (!n._visible) return hide();
      if (!it.special && (!showAll || n._s < 0.16 || n._op < 0.15)) return hide();

      const isFocus = n === focus;
      const isRoot = n === m.root;
      let font = 9.5 + 4.5 * Math.max(0, n._s);
      if (isRoot) font = 13 + 2 * n._s;
      if (isFocus) font = Math.max(font, 14.5);

      const text = n.name + (isRoot && n.subtitle ? '' : '');
      const width = text.length * font * 0.58 + 2;
      const lines = n.labelLines ? 2 : 1;
      const height = font * 1.25 * lines;

      let x, y, anchor;
      if (isFocus || isRoot || norm(n._w) < 0.04) {
        anchor = 'middle';
        x = n._x;
        y = n._y + n._r + font + 3;
      } else if (n._w[0] >= 0) {
        anchor = 'start';
        x = n._x + n._r + 5;
        y = n._y + font * 0.35;
      } else {
        anchor = 'end';
        x = n._x - n._r - 5;
        y = n._y + font * 0.35;
      }

      // Keep labels inside the visible area (matters on narrow screens).
      const halfW = state.size.w / 2 - 4;
      if (anchor === 'start' && x + width > halfW) {
        anchor = 'end';
        x = n._x - n._r - 5;
      } else if (anchor === 'end' && x - width < -halfW) {
        anchor = 'start';
        x = n._x + n._r + 5;
      } else if (anchor === 'middle') {
        x = clamp(x, -halfW + width / 2, halfW - width / 2);
      }
      const x0 = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2;
      if (!it.special && (x0 < -halfW || x0 + width > halfW)) return hide();
      const box = { x0: x0 - 2, x1: x0 + width + 2, y0: y - font - 1, y1: y - font + height + 1 };
      if (!it.special && overlaps(box)) return hide();
      placed.push(box);

      label.removeAttribute('display');
      label.setAttribute('text-anchor', anchor);
      label.setAttribute('font-size', font.toFixed(1));
      label.setAttribute('opacity', Math.max(n._op, isFocus ? 1 : 0).toFixed(3));
      label.classList.toggle('is-focus', isFocus && !isRoot);
      if (n.labelLines) {
        label.removeAttribute('x');
        label.removeAttribute('y');
        n.labelLines[0].setAttribute('x', x.toFixed(1));
        n.labelLines[0].setAttribute('y', y.toFixed(1));
        n.labelLines[1].setAttribute('x', x.toFixed(1));
        n.labelLines[1].setAttribute('y', (y + font * 1.1).toFixed(1));
        n.labelLines[1].setAttribute('font-size', (font * 0.72).toFixed(1));
      } else {
        label.setAttribute('x', x.toFixed(1));
        label.setAttribute('y', y.toFixed(1));
      }
    });
  }

  /** Recompute which relationship links are drawn. */
  function updateLinks() {
    const m = state.model;
    const pairs = [];
    const seen = new Set();
    const add = (a, b, kind) => {
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(key)) return;
      seen.add(key);
      pairs.push({ a: a, b: b, kind: kind });
    };
    const mode = state.prefs.links;
    if (mode === 'all') {
      m.related.forEach((set, id) => set.forEach((r) => add(id, r, 'all')));
    } else if (mode === 'focus') {
      (m.related.get(state.focusId) || new Set()).forEach((r) => add(state.focusId, r, 'focus'));
    }
    if (state.hoverId && m.related.has(state.hoverId)) {
      m.related.get(state.hoverId).forEach((r) => add(state.hoverId, r, 'hover'));
    }

    mapEls.links.textContent = '';
    pairs.forEach((p) => {
      p.el = svgEl('path', { class: 'rel-link' + (p.kind === 'hover' ? ' hover' : '') }, mapEls.links);
    });
    state.linkPairs = pairs;
  }

  /** Apply focus, filter and Focus-mode classes; recompute dimming. */
  function updateNodeStates() {
    const m = state.model;
    const f = state.prefs.filters;
    const nb = neighborhood(state.focusId);
    state.focusNeighborhood = nb;
    const rel = m.related.get(state.focusId) || new Set();

    m.list.forEach((n) => {
      const matches =
        (!f.categories.length || f.categories.indexOf(n.category) >= 0) &&
        (!f.statuses.length || f.statuses.indexOf(n.status) >= 0) &&
        (!f.priorities.length || f.priorities.indexOf(n.priority) >= 0);
      n._dim = n !== m.root && (!matches || (state.prefs.focusMode && !nb.has(n.id)));
      n.el.classList.toggle('is-focus', n.id === state.focusId);
      n.el.classList.toggle('is-related', rel.has(n.id));
      n.el.classList.toggle('is-highlight', n.id === state.highlightId);
      // Keyboard: only the focus neighborhood is in the tab order.
      n.el.setAttribute('tabindex', nb.has(n.id) ? '0' : '-1');
    });
  }

  /* ------------------------------------------------------------------ */
  /* 8. Focus, animation, history                                        */
  /* ------------------------------------------------------------------ */

  function animateCenterTo(target, duration) {
    const c0 = state.center.slice();
    const w = mobius(target, c0);              // target in current display coords
    const r = norm(w);
    state.anim = null;
    if (r < 1e-6 || duration === 0 || REDUCED_MOTION) {
      state.center = clampDisk(target.slice(), 0.9995);
      requestRender();
      return;
    }
    const dist = atanh(Math.min(r, 0.999999));  // half hyperbolic distance
    const back = [-c0[0], -c0[1]];
    const anim = { start: performance.now(), dur: duration || ANIM_MS };
    state.anim = anim;

    const step = (now) => {
      if (state.anim !== anim) return;          // cancelled or replaced
      const p = clamp((now - anim.start) / anim.dur, 0, 1);
      const t = easeInOutCubic(p);
      const k = Math.tanh(t * dist) / r;        // move along the geodesic at uniform hyperbolic speed
      state.center = mobius([w[0] * k, w[1] * k], back);
      renderMap();
      if (p < 1) window.requestAnimationFrame(step);
      else state.anim = null;
    };
    window.requestAnimationFrame(step);
  }

  function focusNode(id, opts) {
    const options = opts || {};
    const m = state.model;
    const node = m.byId.get(id);
    if (!node) return;
    if (options.push !== false && id !== state.focusId) {
      state.history.push(state.focusId);
      if (state.history.length > 100) state.history.shift();
      state.forward = [];
    }
    state.focusId = id;
    state.prefs.lastFocus = id;
    savePrefs();
    onFocusChanged();
    animateCenterTo(node.pos, options.animate === false ? 0 : ANIM_MS);
  }

  function onFocusChanged() {
    updateNodeStates();
    updateLinks();
    renderBreadcrumb();
    renderPanel();
    updateNavButtons();
    requestRender();
  }

  function goBack() {
    while (state.history.length) {
      const id = state.history.pop();
      if (state.model.byId.has(id)) {
        state.forward.push(state.focusId);
        focusNode(id, { push: false });
        return;
      }
    }
    updateNavButtons();
  }

  function goForward() {
    while (state.forward.length) {
      const id = state.forward.pop();
      if (state.model.byId.has(id)) {
        state.history.push(state.focusId);
        focusNode(id, { push: false });
        return;
      }
    }
    updateNavButtons();
  }

  function goHome() {
    state.zoom = 1;
    focusNode(state.model.root.id);
  }

  function updateNavButtons() {
    el.btnBack.disabled = !state.history.length;
    el.btnForward.disabled = !state.forward.length;
  }

  function highlightNode(id) {
    state.highlightId = id;
    clearTimeout(state.highlightTimer);
    updateNodeStates();
    requestRender();
    state.highlightTimer = setTimeout(() => {
      state.highlightId = null;
      if (state.model) { updateNodeStates(); requestRender(); }
    }, 3600);
  }

  function setZoom(z) {
    state.zoom = clamp(z, ZOOM_MIN, ZOOM_MAX);
    requestRender();
  }

  /* ------------------------------------------------------------------ */
  /* 9. Map interaction: click, double-click, drag, wheel, pinch, hover  */
  /* ------------------------------------------------------------------ */

  function nodeIdFromEvent(e) {
    const t = e.target && e.target.closest ? e.target.closest('.node') : null;
    return t ? t.getAttribute('data-id') : null;
  }

  function panBy(dx, dy) {
    const R = state.baseR * state.zoom;
    let d = [dx / R, dy / R];
    const len = norm(d);
    if (len > 0.25) d = [d[0] * 0.25 / len, d[1] * 0.25 / len];
    // Content follows the pointer: new center = T_c^{-1}(-d).
    const c = state.center;
    state.center = clampDisk(mobius([-d[0], -d[1]], [-c[0], -c[1]]), 0.995);
    state.anim = null;
    requestRender();
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (state.pointers.size === 2) {
      const pts = Array.from(state.pointers.values());
      state.pinch = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, zoom: state.zoom };
      state.pointer = null;
      return;
    }
    state.pointer = {
      id: e.pointerId, startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY, moved: false, downId: nodeIdFromEvent(e)
    };
  }

  function onPointerMove(e) {
    if (state.pointers.has(e.pointerId)) state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (state.pinch && state.pointers.size >= 2) {
      const pts = Array.from(state.pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      setZoom(state.pinch.zoom * dist / state.pinch.dist);
      return;
    }

    const p = state.pointer;
    if (p && p.id === e.pointerId) {
      if (!p.moved && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > DRAG_THRESHOLD) {
        p.moved = true;
        el.map.classList.add('dragging');
        hideTooltip();
        try { el.map.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      if (p.moved) {
        panBy(e.clientX - p.lastX, e.clientY - p.lastY);
        p.lastX = e.clientX;
        p.lastY = e.clientY;
      }
      return;
    }

    // Hover (mouse / pen only).
    if (e.pointerType !== 'touch') {
      const id = nodeIdFromEvent(e);
      setHover(id, e);
    }
  }

  function onPointerUp(e) {
    state.pointers.delete(e.pointerId);
    if (state.pointers.size < 2) state.pinch = null;
    const p = state.pointer;
    if (!p || p.id !== e.pointerId) return;
    state.pointer = null;
    el.map.classList.remove('dragging');
    try { el.map.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (p.moved || e.type === 'pointercancel') return;

    const id = nodeIdFromEvent(e) || p.downId;
    if (!id || id !== p.downId) return;
    const now = performance.now();
    const isDouble = state.lastClick.id === id && now - state.lastClick.t < DBLCLICK_MS;
    state.lastClick = { id: id, t: isDouble ? 0 : now };
    if (isDouble) openDetails(id);
    else focusNode(id);
  }

  function onWheel(e) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    setZoom(state.zoom * factor);
  }

  function setHover(id, e) {
    if (id !== state.hoverId) {
      state.hoverId = id;
      if (state.model) { updateLinks(); requestRender(); }
    }
    if (id && e) showTooltip(id, e.clientX, e.clientY);
    else hideTooltip();
  }

  function showTooltip(id, x, y) {
    const n = state.model.byId.get(id);
    if (!n) return;
    const meta = [categoryInfo(n.category).name, n.status ? statusName(n.status) : '', n.priority || '']
      .filter(Boolean).join(' · ');
    const desc = n.description ? (n.description.length > 140 ? n.description.slice(0, 137) + '…' : n.description) : '';
    el.tooltip.innerHTML =
      '<div class="tt-title">' + escapeHtml(n.name) + '</div>' +
      '<div class="tt-meta">' + escapeHtml(meta) + '</div>' +
      (desc ? '<div class="tt-desc">' + escapeHtml(desc) + '</div>' : '');
    el.tooltip.hidden = false;
    const tw = el.tooltip.offsetWidth;
    const th = el.tooltip.offsetHeight;
    let left = x + 14;
    let top = y + 14;
    if (left + tw > window.innerWidth - 8) left = x - tw - 14;
    if (top + th > window.innerHeight - 8) top = y - th - 14;
    el.tooltip.style.left = Math.max(8, left) + 'px';
    el.tooltip.style.top = Math.max(8, top) + 'px';
  }

  function hideTooltip() {
    el.tooltip.hidden = true;
  }

  function openDetails(id) {
    if (id && id !== state.focusId) focusNode(id);
    setPanelOpen(true);
    el.panel.scrollTop = 0;
    el.panel.focus({ preventScroll: true });
  }

  function onMapKeyDown(e) {
    const id = nodeIdFromEvent(e);
    if (!id) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.shiftKey) openDetails(id);
      else focusNode(id);
    }
  }

  function onMapFocusIn(e) {
    const id = nodeIdFromEvent(e);
    if (id) {
      state.hoverId = id;
      updateLinks();
      requestRender();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 10. Breadcrumb and details panel                                    */
  /* ------------------------------------------------------------------ */

  function renderBreadcrumb() {
    const node = state.model.byId.get(state.focusId);
    const path = pathTo(node);
    el.breadcrumb.innerHTML = path.map((n, i) => {
      const last = i === path.length - 1;
      const name = escapeHtml(n.name);
      const part = last
        ? '<span class="crumb-current" aria-current="page">' + name + '</span>'
        : '<button type="button" data-goto="' + escapeHtml(n.id) + '">' + name + '</button>';
      return (i ? '<span class="sep" aria-hidden="true">›</span>' : '') + part;
    }).join('');
  }

  function meterHtml(value, max) {
    const v = clamp(Math.round(value), 0, max);
    let html = '<span class="meter" aria-label="' + v + ' of ' + max + '">';
    for (let i = 1; i <= max; i++) html += '<i class="' + (i <= v ? 'on' : '') + '"></i>';
    return html + '</span>';
  }

  function nodeChip(id) {
    const n = state.model.byId.get(id);
    if (!n) return '';
    return '<button type="button" class="chip node-chip" data-goto="' + escapeHtml(n.id) + '">' +
      '<i style="background:' + escapeHtml(n.color) + '"></i>' + escapeHtml(n.name) + '</button>';
  }

  function renderPanel() {
    const m = state.model;
    const n = m.byId.get(state.focusId) || m.root;
    const cat = categoryInfo(n.category);
    const prompts = (Array.isArray(n.prompts) ? n.prompts : [])
      .concat(state.publicData.settings.reflectionPrompts[n.category] || []);
    const related = Array.from(m.related.get(n.id) || []);
    const parent = n._p ? m.byId.get(n._p) : null;
    const h = [];

    h.push('<div class="p-kicker"><i class="cat-dot" style="background:' + escapeHtml(n.color) + '"></i>' +
      escapeHtml(cat.name) + (n.private ? ' · Private' : '') + '</div>');
    h.push('<h2 class="p-title">' + escapeHtml(n.name) + '</h2>');
    if (n.subtitle) h.push('<div class="p-sub">' + escapeHtml(n.subtitle) + '</div>');
    if (n.description) h.push('<p class="p-desc">' + escapeHtml(n.description) + '</p>');

    // Key facts.
    const cells = [];
    cells.push(['Status', n.status ? '<span class="status-pill s-' + escapeHtml(n.status) + '">' + escapeHtml(statusName(n.status)) + '</span>' : '—']);
    cells.push(['Priority', escapeHtml(n.priority ? priorityName(n.priority) : '—')]);
    if (isNum(n.progress)) {
      const p = clamp(n.progress, 0, 100);
      cells.push(['Progress', p + '%<div class="bar" style="margin-top:6px"><span style="width:' + p + '%"></span></div>']);
    }
    if (n.target) cells.push(['Target', escapeHtml(n.target)]);
    if (isNum(n.importance)) cells.push(['Importance', meterHtml(n.importance, 5)]);
    if (isNum(n.attention)) cells.push(['Attention', meterHtml(n.attention, 5)]);
    h.push('<div class="p-grid">' + cells.map((c) =>
      '<div class="p-cell"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>').join('') + '</div>');

    if (n.why) h.push('<div class="p-section"><h3>Why it matters</h3><p>' + escapeHtml(n.why) + '</p></div>');
    if (n.nextAction) h.push('<div class="p-section"><h3>Next action</h3><p class="p-next">' + escapeHtml(n.nextAction) + '</p></div>');

    if (prompts.length) {
      h.push('<div class="p-section"><h3>Reflection prompts</h3><ul class="prompts">' +
        prompts.map((q) => '<li>' + escapeHtml(q) + '</li>').join('') + '</ul></div>');
    }

    if (n.notes) h.push('<div class="p-section"><h3>Notes</h3><p class="p-notes">' + escapeHtml(n.notes) + '</p></div>');

    if (state.privateMode && (n.privateNotes || Array.isArray(n.metrics))) {
      let block = '<div class="p-section p-private"><h3>Private</h3>';
      if (n.privateNotes) block += '<p class="p-notes">' + escapeHtml(n.privateNotes) + '</p>';
      if (Array.isArray(n.metrics) && n.metrics.length) {
        block += '<table class="metrics">' + n.metrics.map((mt) => {
          const bar = isNum(mt.progress)
            ? '<div class="bar"><span style="width:' + clamp(mt.progress, 0, 100) + '%"></span></div>' : '';
          return '<tr><td>' + escapeHtml(mt.label) + bar + '</td><td>' + escapeHtml(mt.value) + '</td></tr>';
        }).join('') + '</table>';
      }
      h.push(block + '</div>');
    }

    if (Array.isArray(n.tags) && n.tags.length) {
      h.push('<div class="p-section"><h3>Tags</h3><div class="chip-row">' +
        n.tags.map((t) => '<span class="chip">' + escapeHtml(t) + '</span>').join('') + '</div></div>');
    }
    if (related.length) {
      h.push('<div class="p-section"><h3>Related (' + related.length + ')</h3><div class="chip-row">' +
        related.map(nodeChip).join('') + '</div></div>');
    }
    if (n.children.length) {
      h.push('<div class="p-section"><h3>Inside (' + n.children.length + ')</h3><div class="chip-row">' +
        n.children.map((c) => nodeChip(c.id)).join('') + '</div></div>');
    }
    if (parent) {
      h.push('<div class="p-section"><h3>Part of</h3><div class="chip-row">' + nodeChip(parent.id) + '</div></div>');
    }

    h.push('<div class="p-section"><p class="hint">Click: focus · Double-click: details · Drag: pan · Scroll: zoom · ' +
      '<kbd>/</kbd> search · <kbd>H</kbd> home · <kbd>F</kbd> focus mode · <kbd>Alt</kbd>+←/→ history</p></div>');

    el.panel.innerHTML = h.join('');
  }

  function setPanelOpen(open) {
    state.prefs.panelOpen = !!open;
    document.body.classList.toggle('panel-closed', !open);
    el.btnPanel.setAttribute('aria-expanded', open ? 'true' : 'false');
    savePrefs();
    measureMap();
  }

  /* ------------------------------------------------------------------ */
  /* 11. Search                                                          */
  /* ------------------------------------------------------------------ */

  function buildSearchIndex() {
    state.searchIndex = state.model.list.map((n) => ({
      node: n,
      name: String(n.name || '').toLowerCase(),
      tags: (Array.isArray(n.tags) ? n.tags.join(' ') : '').toLowerCase(),
      hay: [n.id, n.name, n.subtitle, n.description, n.why, n.nextAction, n.notes]
        .filter(Boolean).join(' ').toLowerCase()
    }));
  }

  function runSearch(query) {
    const q = query.trim().toLowerCase();
    if (!q) { closeSearch(); return; }
    const scored = [];
    state.searchIndex.forEach((e) => {
      let s = 0;
      if (e.name === q) s = 100;
      else if (e.name.startsWith(q)) s = 80;
      else if (e.name.indexOf(q) >= 0) s = 60;
      else if (e.tags.indexOf(q) >= 0) s = 40;
      else if (e.hay.indexOf(q) >= 0) s = 20;
      if (s) scored.push({ node: e.node, s: s });
    });
    scored.sort((a, b) => b.s - a.s || a.node.depth - b.node.depth || a.node.name.localeCompare(b.node.name));
    state.searchResults = scored.slice(0, 8).map((x) => x.node);
    state.searchSel = state.searchResults.length ? 0 : -1;
    renderSearchResults();
  }

  function renderSearchResults() {
    const list = el.searchResults;
    if (!state.searchResults.length) {
      list.innerHTML = '<li class="sr-empty" role="option" aria-disabled="true">No matching node</li>';
    } else {
      list.innerHTML = state.searchResults.map((n, i) => {
        const path = pathTo(n).slice(1, -1).map((p) => p.name).join(' › ');
        return '<li role="option" id="sr-' + i + '" data-goto="' + escapeHtml(n.id) + '" aria-selected="' + (i === state.searchSel) + '">' +
          '<i class="cat-dot" style="background:' + escapeHtml(n.color) + '"></i>' +
          '<span>' + escapeHtml(n.name) + '</span>' +
          '<span class="sr-path">' + escapeHtml(path) + '</span></li>';
      }).join('');
    }
    list.hidden = false;
    el.searchInput.setAttribute('aria-expanded', 'true');
    if (state.searchSel >= 0) el.searchInput.setAttribute('aria-activedescendant', 'sr-' + state.searchSel);
    else el.searchInput.removeAttribute('aria-activedescendant');
  }

  function closeSearch() {
    el.searchResults.hidden = true;
    el.searchInput.setAttribute('aria-expanded', 'false');
    el.searchInput.removeAttribute('aria-activedescendant');
    state.searchResults = [];
    state.searchSel = -1;
  }

  function selectSearchResult(id) {
    closeSearch();
    el.searchInput.value = '';
    el.searchInput.blur();
    setView('map');
    focusNode(id);
    highlightNode(id);
  }

  function onSearchKey(e) {
    const n = state.searchResults.length;
    if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      state.searchSel = (state.searchSel + 1) % n;
      renderSearchResults();
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      state.searchSel = (state.searchSel - 1 + n) % n;
      renderSearchResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.searchSel >= 0) selectSearchResult(state.searchResults[state.searchSel].id);
    } else if (e.key === 'Escape') {
      el.searchInput.value = '';
      closeSearch();
      el.searchInput.blur();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 12. Filters, settings, popovers, private mode                       */
  /* ------------------------------------------------------------------ */

  function buildFilterChips() {
    const s = state.publicData.settings;
    const f = state.prefs.filters;
    const cats = s.categories.filter((c) => c.id !== 'self');
    const make = (container, items, key, withDot) => {
      container.innerHTML = items.map((it) =>
        '<button type="button" class="chip" data-filter="' + key + '" data-value="' + escapeHtml(it.id) + '" aria-pressed="' +
        (f[key].indexOf(it.id) >= 0) + '">' + (withDot ? '<i style="background:' + escapeHtml(it.color) + '"></i>' : '') +
        escapeHtml(it.name) + '</button>').join('');
    };
    make(el.filterCategories, cats, 'categories', true);
    make(el.filterStatuses, s.statuses, 'statuses', false);
    make(el.filterPriorities, s.priorities, 'priorities', false);
    updateFilterBadge();
  }

  function updateFilterBadge() {
    const f = state.prefs.filters;
    const count = f.categories.length + f.statuses.length + f.priorities.length;
    el.filterCount.textContent = String(count);
    el.filterCount.hidden = count === 0;
  }

  function onFilterClick(e) {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    const key = btn.getAttribute('data-filter');
    const value = btn.getAttribute('data-value');
    const arr = state.prefs.filters[key];
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1); else arr.push(value);
    btn.setAttribute('aria-pressed', String(i < 0));
    applyFilterChange();
  }

  function applyFilterChange() {
    updateFilterBadge();
    savePrefs();
    updateNodeStates();
    requestRender();
  }

  function clearFilters() {
    state.prefs.filters = { categories: [], statuses: [], priorities: [] };
    buildFilterChips();
    applyFilterChange();
  }

  function togglePopover(btn, pop, force) {
    const open = force !== undefined ? force : pop.hidden;
    closePopovers(pop);
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }

  function closePopovers(except) {
    [[el.btnFilters, el.popFilters], [el.btnSettings, el.popSettings]].forEach((pair) => {
      if (pair[1] !== except) {
        pair[1].hidden = true;
        pair[0].setAttribute('aria-expanded', 'false');
      }
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    el.setTheme.value = theme;
  }

  function syncSettingsUi() {
    el.setLabels.checked = !!state.prefs.labels;
    el.setLinks.value = state.prefs.links;
    el.setRings.checked = !!state.prefs.rings;
    el.setTheme.value = document.documentElement.getAttribute('data-theme') || 'dark';
    el.btnFocus.setAttribute('aria-pressed', String(!!state.prefs.focusMode));
  }

  function updatePrivateUi() {
    el.btnPrivate.setAttribute('aria-pressed', String(state.privateMode));
    el.privateBanner.hidden = !state.privateMode;
    if (state.privateData) {
      const nodes = Array.isArray(state.privateData.nodes) ? state.privateData.nodes.length : 0;
      const ov = state.privateData.overrides ? Object.keys(state.privateData.overrides).length : 0;
      el.privateStatus.textContent = 'Loaded (' + (state.privateSource === 'file' ? 'from file, memory only' : 'data/private-data.json') +
        '): ' + nodes + ' private nodes, ' + ov + ' overrides.';
      el.btnUnloadPrivate.hidden = false;
    } else {
      el.privateStatus.textContent = 'Not loaded. Nothing private is on this page.';
      el.btnUnloadPrivate.hidden = true;
    }
  }

  async function togglePrivateMode() {
    const next = !state.privateMode;
    if (next && !state.privateData && !state.privateTried) {
      state.privateTried = true;
      await tryAutoLoadPrivate();
    }
    state.privateMode = next;
    updatePrivateUi();
    rebuild();
    if (next) {
      toast(state.privateData
        ? 'Private Mode on. Private nodes and notes are visible.'
        : 'Private Mode on. Private branch shown. No private-data.json loaded — use Settings › Load private-data.json.');
    } else {
      toast('Private Mode off. Private content hidden.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 13. Views: timeline, balance, decision                              */
  /* ------------------------------------------------------------------ */

  function setView(view) {
    state.prefs.view = view;
    savePrefs();
    ['map', 'timeline', 'balance', 'decision'].forEach((v) => {
      const tab = $('tab-' + v);
      const panel = $('view-' + v);
      const active = v === view;
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
      panel.hidden = !active;
    });
    hideTooltip();
    renderActiveView();
    if (view === 'map') measureMap();
  }

  function renderActiveView() {
    const v = state.prefs.view;
    if (v === 'timeline') renderTimeline();
    else if (v === 'balance') renderBalance();
    else if (v === 'decision') renderDecision();
  }

  function goToNodeFromView(id) {
    if (!state.model.byId.has(id)) {
      toast('That node is not visible (it may be private).');
      return;
    }
    setView('map');
    focusNode(id);
    highlightNode(id);
  }

  function renderTimeline() {
    const m = state.model;
    const periods = state.publicData.timeline.map((p) => deepClone(p));
    if (state.privateMode && state.privateData && Array.isArray(state.privateData.timeline)) {
      state.privateData.timeline.forEach((pp) => {
        const existing = periods.find((p) => p.period === pp.period);
        if (existing) existing.items = (existing.items || []).concat(pp.items || []);
        else periods.push(deepClone(pp));
      });
    }
    let html = '<div class="view-head"><h2>Timeline</h2><p class="hint">Planning roadmap, not a prediction. Reviewed and changed as reality changes.</p></div>';
    if (!periods.length) {
      html += '<p class="hint">No timeline defined. Add a "timeline" array to public-data.json.</p>';
    }
    html += '<div class="timeline">';
    periods.forEach((p) => {
      html += '<section class="tl-col"><div class="tl-period">' + escapeHtml(p.period) + '</div>' +
        '<div class="tl-label">' + escapeHtml(p.label || '') + '</div>';
      (p.items || []).forEach((it) => {
        const n = it.node ? m.byId.get(it.node) : null;
        const color = n ? n.color : 'var(--muted)';
        const meta = n ? [categoryInfo(n.category).name, n.status ? statusName(n.status) : '', n.priority || ''].filter(Boolean).join(' · ') : '';
        html += '<button type="button" class="tl-item" ' + (n ? 'data-goto="' + escapeHtml(n.id) + '"' : 'disabled') + '>' +
          '<i class="cat-dot" style="background:' + escapeHtml(color) + '"></i><span>' +
          '<span class="tl-title">' + escapeHtml(it.title) + '</span><br>' +
          '<span class="tl-meta">' + escapeHtml(meta) + '</span></span></button>';
      });
      html += '</section>';
    });
    html += '</div>';
    el.viewTimeline.innerHTML = html;
  }

  function renderBalance() {
    const m = state.model;
    const cats = state.publicData.settings.balanceCategories;
    const rows = cats.map((cid) => {
      const n = m.root.children.find((c) => c.category === cid);
      return n ? { n: n, cat: categoryInfo(cid) } : null;
    }).filter(Boolean);

    let html = '<div class="view-head"><h2>Life Balance</h2><p class="hint">Personal self-management indicators (1–5), not a scientific measurement. Edit them in public-data.json.</p></div>';
    if (rows.length < 3) {
      el.viewBalance.innerHTML = html + '<p class="hint">Add "balanceCategories" and importance / attention values to first-level nodes.</p>';
      return;
    }

    // Radar chart.
    const size = 360;
    const cx = size / 2;
    const cy = size / 2;
    const R = 120;
    const N = rows.length;
    const ang = (i) => -Math.PI / 2 + 2 * Math.PI * i / N;
    const pt = (i, v) => [cx + Math.cos(ang(i)) * R * v / 5, cy + Math.sin(ang(i)) * R * v / 5];
    let svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="Importance versus attention by life area">';
    for (let k = 1; k <= 5; k++) {
      svg += '<polygon class="ring-guide" points="' + rows.map((_, i) => pt(i, k).map((v) => v.toFixed(1)).join(',')).join(' ') + '"/>';
    }
    rows.forEach((row, i) => {
      const e = pt(i, 5);
      svg += '<line class="axis" x1="' + cx + '" y1="' + cy + '" x2="' + e[0].toFixed(1) + '" y2="' + e[1].toFixed(1) + '"/>';
      const l = pt(i, 6.1);
      const anchor = Math.abs(Math.cos(ang(i))) < 0.2 ? 'middle' : (Math.cos(ang(i)) > 0 ? 'start' : 'end');
      svg += '<text class="axis-label" data-goto="' + escapeHtml(row.n.id) + '" x="' + l[0].toFixed(1) + '" y="' + (l[1] + 4).toFixed(1) +
        '" text-anchor="' + anchor + '">' + escapeHtml(row.cat.name) + '</text>';
    });
    const poly = (key, cls) => '<polygon class="' + cls + '" points="' +
      rows.map((row, i) => pt(i, isNum(row.n[key]) ? clamp(row.n[key], 0, 5) : 0).map((v) => v.toFixed(1)).join(',')).join(' ') + '"/>';
    svg += poly('importance', 'poly-imp') + poly('attention', 'poly-att') + '</svg>';

    html += '<div class="balance"><div class="balance-chart">' + svg +
      '<div class="balance-key"><span><i class="k-imp"></i>Importance</span><span><i class="k-att"></i>Attention</span></div></div>';

    // Table.
    html += '<table class="data-table"><thead><tr><th>Area</th><th>Importance</th><th>Attention</th><th class="num">Gap</th><th>Progress</th></tr></thead><tbody>';
    rows.forEach((row) => {
      const n = row.n;
      const gap = (isNum(n.importance) && isNum(n.attention)) ? n.importance - n.attention : null;
      const p = isNum(n.progress) ? clamp(n.progress, 0, 100) : null;
      html += '<tr><td><button type="button" class="row-link" data-goto="' + escapeHtml(n.id) + '">' +
        '<i class="cat-dot" style="background:' + escapeHtml(n.color) + '"></i>' + escapeHtml(row.cat.name) + '</button></td>' +
        '<td>' + (isNum(n.importance) ? meterHtml(n.importance, 5) : '—') + '</td>' +
        '<td>' + (isNum(n.attention) ? meterHtml(n.attention, 5) : '—') + '</td>' +
        '<td class="num ' + (gap !== null && gap >= 2 ? 'gap-pos' : '') + '">' + (gap === null ? '—' : (gap > 0 ? '+' : '') + gap) + '</td>' +
        '<td>' + (p === null ? '—' : '<div class="bar" title="' + p + '%"><span style="width:' + p + '%"></span></div>') + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<p class="hint" style="margin-top:14px">Gap = importance − attention. A gap of +2 or more is flagged: important, but getting less attention than it needs.</p>';
    el.viewBalance.innerHTML = html;
  }

  /** Decision data = public → private (Private Mode) → local edits in this browser. */
  function getDecisionData() {
    const base = deepClone(state.publicData.decision);
    if (!base || !Array.isArray(base.options) || !Array.isArray(base.criteria)) return null;
    base.scores = base.scores || {};
    base.notes = base.notes || {};
    const mergeScores = (src) => {
      if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach((opt) => {
        base.scores[opt] = Object.assign({}, base.scores[opt] || {}, src[opt] || {});
      });
    };
    if (state.privateMode && state.privateData && state.privateData.decision) {
      mergeScores(state.privateData.decision.scores);
      Object.assign(base.notes, state.privateData.decision.notes || {});
    }
    let local = null;
    try { local = JSON.parse(storageGet(DECISION_KEY) || 'null'); } catch (e) { local = null; }
    mergeScores(local);
    base.hasLocal = !!(local && Object.keys(local).length);
    return base;
  }

  function saveDecisionEdit(opt, crit, value) {
    let local = {};
    try { local = JSON.parse(storageGet(DECISION_KEY) || '{}') || {}; } catch (e) { local = {}; }
    local[opt] = local[opt] || {};
    if (value === '') delete local[opt][crit];
    else local[opt][crit] = Number(value);
    storageSet(DECISION_KEY, JSON.stringify(local));
  }

  function heatStyle(v) {
    if (!isNum(v)) return '';
    const a = 0.06 + (clamp(v, 1, 5) - 1) / 4 * 0.5;
    return 'background: rgba(var(--heat-hi), ' + a.toFixed(2) + ')';
  }

  function renderDecision() {
    const d = getDecisionData();
    let html = '<div class="view-head"><h2>Decision Mode</h2><p class="hint">Visualizes trade-offs. It does not decide.</p></div>';
    if (!d) {
      el.viewDecision.innerHTML = html + '<p class="hint">Add a "decision" object to public-data.json.</p>';
      return;
    }
    html += '<div class="decision-wrap">';
    html += '<div><div style="font-size:16px;font-weight:500">' + escapeHtml(d.question || '') + '</div>' +
      (d.note ? '<p class="hint">' + escapeHtml(d.note) + '</p>' : '') + '</div>';

    // Matrix.
    html += '<div class="decision-matrix"><table class="data-table"><thead><tr><th>Criterion</th>';
    d.options.forEach((o, i) => {
      html += '<th><span class="opt-head"><i class="cat-dot" style="background:' + OPTION_COLORS[i % OPTION_COLORS.length] + '"></i>' + escapeHtml(o.name) + '</span></th>';
    });
    html += '</tr></thead><tbody>';
    d.criteria.forEach((c) => {
      html += '<tr><td>' + escapeHtml(c.name) +
        (c.hint ? '<span class="crit-hint">' + escapeHtml(c.hint) + '</span>' : '') +
        (d.notes[c.id] && state.privateMode ? '<span class="crit-hint">' + escapeHtml(d.notes[c.id]) + '</span>' : '') + '</td>';
      d.options.forEach((o) => {
        const v = (d.scores[o.id] || {})[c.id];
        let opts = '<option value="">–</option>';
        for (let k = 1; k <= 5; k++) opts += '<option value="' + k + '"' + (v === k ? ' selected' : '') + '>' + k + '</option>';
        html += '<td class="score"><select data-opt="' + escapeHtml(o.id) + '" data-crit="' + escapeHtml(c.id) + '" style="' + heatStyle(v) +
          '" aria-label="' + escapeHtml(o.name + ' – ' + c.name) + '">' + opts + '</select></td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';

    // Profile chart.
    html += '<div class="decision-chart" id="decision-chart">' + decisionChartSvg(d) +
      '<div class="decision-legend">' + d.options.map((o, i) =>
        '<span class="chip" data-opt-hover="' + escapeHtml(o.id) + '"><i style="background:' + OPTION_COLORS[i % OPTION_COLORS.length] + '"></i>' +
        escapeHtml(o.name) + '</span>').join('') + '</div></div>';

    html += '<div class="decision-notes">1 = poor for me, 5 = good for me. No total score by design: look at where options differ, then decide. ' +
      'Your edits are saved in this browser only. ' +
      '<button type="button" class="link-btn" id="btn-reset-decision"' + (d.hasLocal ? '' : ' hidden') + '>Reset my edits</button></div>';
    html += '</div>';
    el.viewDecision.innerHTML = html;
  }

  function decisionChartSvg(d) {
    const W = 760;
    const H = 260;
    const pad = { l: 28, r: 16, t: 14, b: 54 };
    const n = d.criteria.length;
    const x = (i) => pad.l + (W - pad.l - pad.r) * (n === 1 ? 0.5 : i / (n - 1));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - 1) / 4);
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Option profiles across criteria">';
    for (let v = 1; v <= 5; v++) {
      svg += '<line class="grid" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text class="tick" x="' + (pad.l - 8) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + '</text>';
    }
    d.criteria.forEach((c, i) => {
      svg += '<line class="grid" x1="' + x(i) + '" x2="' + x(i) + '" y1="' + pad.t + '" y2="' + (H - pad.b) + '"/>' +
        '<text class="crit" transform="translate(' + x(i) + ',' + (H - pad.b + 14) + ') rotate(20)">' + escapeHtml(c.name) + '</text>';
    });
    d.options.forEach((o, oi) => {
      const color = OPTION_COLORS[oi % OPTION_COLORS.length];
      const pts = [];
      d.criteria.forEach((c, i) => {
        const v = (d.scores[o.id] || {})[c.id];
        if (isNum(v)) pts.push([x(i), y(clamp(v, 1, 5))]);
      });
      svg += '<g class="opt" data-opt-hover="' + escapeHtml(o.id) + '">';
      if (pts.length > 1) svg += '<polyline class="opt-line" stroke="' + color + '" points="' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>';
      pts.forEach((p) => { svg += '<circle class="opt-pt" r="3.5" fill="' + color + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '"/>'; });
      svg += '</g>';
    });
    return svg + '</svg>';
  }

  function setDecisionHover(optId) {
    const chart = $('decision-chart');
    if (!chart) return;
    chart.classList.toggle('has-hover', !!optId);
    chart.querySelectorAll('.opt').forEach((g) => {
      g.classList.toggle('hover', g.getAttribute('data-opt-hover') === optId);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 14. Layout measurement and rebuild                                  */
  /* ------------------------------------------------------------------ */

  function measureMap() {
    const rect = el.map.getBoundingClientRect();
    state.size = { w: rect.width, h: rect.height };
    state.baseR = Math.max(60, Math.min(rect.width, rect.height) / 2 - 28);
    requestRender();
  }

  /** Rebuild model + layout + DOM (data or Private Mode changed). */
  function rebuild() {
    state.model = buildModel();
    layoutTree(state.model.root);
    buildSearchIndex();
    buildMapDom();
    if (!state.model.byId.has(state.focusId)) state.focusId = state.model.root.id;
    state.hoverId = null;
    state.anim = null;
    state.center = clampDisk(state.model.byId.get(state.focusId).pos.slice(), 0.9995);
    onFocusChanged();
    renderActiveView();
    measureMap();
  }

  /* ------------------------------------------------------------------ */
  /* 15. Wiring                                                          */
  /* ------------------------------------------------------------------ */

  function cacheElements() {
    Object.assign(el, {
      map: $('map'), panel: $('panel'), breadcrumb: $('breadcrumb'), tooltip: $('tooltip'), toast: $('toast'),
      loader: $('loader'), loaderMessage: $('loader-message'), loaderActions: $('loader-actions'),
      btnPickPublic: $('btn-pick-public'), filePublic: $('file-public'), filePrivate: $('file-private'),
      searchInput: $('search-input'), searchResults: $('search-results'),
      btnBack: $('btn-back'), btnHome: $('btn-home'), btnForward: $('btn-forward'),
      btnFocus: $('btn-focus'), btnFilters: $('btn-filters'), popFilters: $('pop-filters'), filterCount: $('filter-count'),
      filterCategories: $('filter-categories'), filterStatuses: $('filter-statuses'), filterPriorities: $('filter-priorities'),
      btnClearFilters: $('btn-clear-filters'), btnPrivate: $('btn-private'), privateBanner: $('private-banner'),
      btnSettings: $('btn-settings'), popSettings: $('pop-settings'),
      setLabels: $('set-labels'), setLinks: $('set-links'), setRings: $('set-rings'), setTheme: $('set-theme'),
      privateStatus: $('private-status'), btnLoadPrivate: $('btn-load-private'), btnUnloadPrivate: $('btn-unload-private'),
      btnResetPrefs: $('btn-reset-prefs'), btnPanel: $('btn-panel'),
      btnZoomIn: $('btn-zoom-in'), btnZoomOut: $('btn-zoom-out'), btnZoomReset: $('btn-zoom-reset'),
      viewTimeline: $('view-timeline'), viewBalance: $('view-balance'), viewDecision: $('view-decision')
    });
  }

  function isTyping(target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  }

  function wireEvents() {
    // Map.
    el.map.addEventListener('pointerdown', onPointerDown);
    el.map.addEventListener('pointermove', onPointerMove);
    el.map.addEventListener('pointerup', onPointerUp);
    el.map.addEventListener('pointercancel', onPointerUp);
    el.map.addEventListener('pointerleave', (e) => { if (!state.pointer) setHover(null, e); });
    el.map.addEventListener('wheel', onWheel, { passive: false });
    el.map.addEventListener('keydown', onMapKeyDown);
    el.map.addEventListener('focusin', onMapFocusIn);
    el.map.addEventListener('focusout', () => { state.hoverId = null; if (state.model) { updateLinks(); requestRender(); } });
    el.map.addEventListener('dblclick', (e) => e.preventDefault());

    // Any [data-goto] element in panel, breadcrumb, views and search results.
    document.addEventListener('click', (e) => {
      const target = e.target.closest ? e.target.closest('[data-goto]') : null;
      if (!target || target.closest('#map')) return;
      const id = target.getAttribute('data-goto');
      if (target.closest('#search-results')) { selectSearchResult(id); return; }
      if (target.closest('.view-scroll')) { goToNodeFromView(id); return; }
      if (state.prefs.view !== 'map') setView('map');
      focusNode(id);
    });

    // Navigation.
    el.btnBack.addEventListener('click', goBack);
    el.btnForward.addEventListener('click', goForward);
    el.btnHome.addEventListener('click', goHome);
    el.btnZoomIn.addEventListener('click', () => setZoom(state.zoom * 1.25));
    el.btnZoomOut.addEventListener('click', () => setZoom(state.zoom / 1.25));
    el.btnZoomReset.addEventListener('click', () => {
      state.zoom = 1;
      animateCenterTo(state.model.byId.get(state.focusId).pos, ANIM_MS);
    });
    el.btnPanel.addEventListener('click', () => setPanelOpen(document.body.classList.contains('panel-closed')));

    // Tabs (click + arrow keys).
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => setView(tab.getAttribute('data-view')));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const tabs = Array.from(document.querySelectorAll('.tab'));
        const i = tabs.indexOf(tab);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        setView(next.getAttribute('data-view'));
      });
    });

    // Search.
    el.searchInput.addEventListener('input', () => runSearch(el.searchInput.value));
    el.searchInput.addEventListener('keydown', onSearchKey);
    el.searchInput.addEventListener('focus', () => { if (el.searchInput.value) runSearch(el.searchInput.value); });
    el.searchResults.addEventListener('mousedown', (e) => e.preventDefault()); // keep input focus until click completes

    // Filters.
    el.btnFilters.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(el.btnFilters, el.popFilters); });
    el.popFilters.addEventListener('click', onFilterClick);
    el.btnClearFilters.addEventListener('click', clearFilters);

    // Focus mode.
    el.btnFocus.addEventListener('click', () => {
      state.prefs.focusMode = !state.prefs.focusMode;
      el.btnFocus.setAttribute('aria-pressed', String(state.prefs.focusMode));
      savePrefs();
      updateNodeStates();
      requestRender();
    });

    // Private.
    el.btnPrivate.addEventListener('click', togglePrivateMode);
    el.btnLoadPrivate.addEventListener('click', () => el.filePrivate.click());
    el.filePrivate.addEventListener('change', async () => {
      const file = el.filePrivate.files && el.filePrivate.files[0];
      el.filePrivate.value = '';
      if (!file) return;
      try {
        setPrivateData(await readFileAsJson(file), 'file');
        state.privateMode = true;
        updatePrivateUi();
        rebuild();
        toast('Private data loaded into memory only. Private Mode on.');
      } catch (err) {
        toast('Could not load private data: ' + err.message, 5000);
      }
    });
    el.btnUnloadPrivate.addEventListener('click', () => {
      state.privateData = null;
      state.privateSource = '';
      updatePrivateUi();
      rebuild();
      toast('Private data unloaded.');
    });

    // Settings.
    el.btnSettings.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(el.btnSettings, el.popSettings); });
    el.setLabels.addEventListener('change', () => { state.prefs.labels = el.setLabels.checked; savePrefs(); requestRender(); });
    el.setRings.addEventListener('change', () => { state.prefs.rings = el.setRings.checked; savePrefs(); requestRender(); });
    el.setLinks.addEventListener('change', () => { state.prefs.links = el.setLinks.value; savePrefs(); updateLinks(); requestRender(); });
    el.setTheme.addEventListener('change', () => { state.prefs.theme = el.setTheme.value; savePrefs(); applyTheme(el.setTheme.value); });
    el.btnResetPrefs.addEventListener('click', () => {
      storageRemove(PREFS_KEY);
      state.prefs = loadPrefs();
      state.prefs.panelOpen = window.innerWidth > 900;
      applyTheme((window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark');
      syncSettingsUi();
      buildFilterChips();
      setPanelOpen(state.prefs.panelOpen);
      updateNodeStates();
      updateLinks();
      requestRender();
      toast('View settings reset.');
    });

    // Close popovers on outside click.
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('.popover-wrap')) closePopovers(null);
      if (!e.target.closest || !e.target.closest('.search')) closeSearch();
    });

    // Decision view interactions.
    el.viewDecision.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-opt]');
      if (!sel) return;
      saveDecisionEdit(sel.getAttribute('data-opt'), sel.getAttribute('data-crit'), sel.value);
      renderDecision();
      const again = el.viewDecision.querySelector('select[data-opt="' + sel.getAttribute('data-opt') + '"][data-crit="' + sel.getAttribute('data-crit') + '"]');
      if (again) again.focus();
    });
    el.viewDecision.addEventListener('click', (e) => {
      if (e.target.id === 'btn-reset-decision') {
        storageRemove(DECISION_KEY);
        renderDecision();
      }
    });
    el.viewDecision.addEventListener('mouseover', (e) => {
      const t = e.target.closest('[data-opt-hover]');
      setDecisionHover(t ? t.getAttribute('data-opt-hover') : null);
    });
    el.viewDecision.addEventListener('mouseleave', () => setDecisionHover(null));

    // Global keyboard shortcuts.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closePopovers(null); closeSearch(); hideTooltip(); return; }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey) return;
      if (!state.model) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); return; }
      if (e.altKey) return;
      switch (e.key) {
        case '/': e.preventDefault(); el.searchInput.focus(); break;
        case 'h': case 'H': goHome(); break;
        case 'f': case 'F': el.btnFocus.click(); break;
        case 'p': case 'P': togglePrivateMode(); break;
        case '+': case '=': setZoom(state.zoom * 1.25); break;
        case '-': case '_': setZoom(state.zoom / 1.25); break;
        case '0': el.btnZoomReset.click(); break;
        default: break;
      }
    });

    // Resize.
    if (window.ResizeObserver) new ResizeObserver(measureMap).observe(el.map);
    window.addEventListener('resize', measureMap);

    // Loader: pick public-data.json manually.
    el.btnPickPublic.addEventListener('click', () => el.filePublic.click());
    el.filePublic.addEventListener('change', async () => {
      const file = el.filePublic.files && el.filePublic.files[0];
      el.filePublic.value = '';
      if (!file) return;
      try {
        start(normalizePublicData(await readFileAsJson(file)));
      } catch (err) {
        showLoader('Could not use that file: ' + err.message, true);
      }
    });
  }

  /** Start the app once public data is available. */
  function start(data) {
    state.publicData = data;
    hideLoader();
    document.title = (data.meta.title || 'Life OS') + ' — ' + (data.meta.subtitle || 'Hyperbolic Life Map');
    buildFilterChips();
    syncSettingsUi();
    updatePrivateUi();
    state.focusId = state.prefs.lastFocus || 'self';
    rebuild();
    setPanelOpen(state.prefs.panelOpen);
    setView(state.prefs.view);
  }

  async function init() {
    cacheElements();
    state.prefs = loadPrefs();
    if (state.prefs.panelOpen === null) state.prefs.panelOpen = window.innerWidth > 900;
    if (state.prefs.theme === 'light' || state.prefs.theme === 'dark') applyTheme(state.prefs.theme);
    wireEvents();

    if (location.protocol === 'file:') {
      showLoader('This page was opened directly from disk, so the browser blocks loading data files.', true);
      return;
    }
    showLoader('Loading life map…', false);
    let data;
    try {
      data = normalizePublicData(await fetchJson(PUBLIC_URL));
    } catch (err) {
      showLoader('Could not load ' + PUBLIC_URL + ' (' + err.message + ').', true);
      return;
    }
    try {
      start(data);
    } catch (err) {
      console.error(err);
      showLoader('The data loaded, but the map could not start: ' + err.message, true);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
