/* Trail Mapper: find South Florida nature trails from OpenStreetMap, show each area's
   trail map, track the hiker's live position, warn when they leave the path and route
   them back to parking along the mapped paths. No server of its own: data comes from the
   public Overpass and Nominatim services and is cached on the phone. */
'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const el = (tag, props, kids) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach((c) => c && n.append(c));
    return n;
  };

  /* ---------------- constants ---------------- */
  // Rough box around South Florida (west, north, east, south) for place search.
  const SF_VIEWBOX = '-82.95,28.0,-79.75,24.35';
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  const DAY = 864e5;
  const TRAIL_HW = '^(path|footway|track|bridleway|cycleway|steps|pedestrian)$';
  const NOT_SIDEWALK = '[footway!~"^(sidewalk|crossing|access_aisle|traffic_island)$"][access!~"^(private|no)$"]';
  const EASY_RX = '^(asphalt|concrete|paved|paving_stones|wood|boardwalk|pier|concrete:plates|concrete:lanes|metal)$';
  const COLORS = () => {
    const cs = getComputedStyle(document.documentElement);
    return {
      board: cs.getPropertyValue('--board').trim() || '#9a5b2e',
      paved: cs.getPropertyValue('--paved').trim() || '#5f6670',
      nat: cs.getPropertyValue('--nat').trim() || '#2f7d4f',
      unk: cs.getPropertyValue('--unk').trim() || '#8f8a7c',
      sun: cs.getPropertyValue('--sun').trim() || '#e8984a',
      danger: '#d93025',
      route: '#1a73e8',
    };
  };

  /* ---------------- small storage helpers ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tm:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tm:' + k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
  };
  const memCache = new Map();
  const dataUrl = (key) => new URL('__tm-data/' + encodeURIComponent(key), location.href).href;
  async function cacheGet(key, maxAge) {
    try {
      if (window.caches) {
        const c = await caches.open('tm-data-v1');
        const r = await c.match(dataUrl(key));
        if (r) {
          const t = +r.headers.get('x-time') || 0;
          if (!maxAge || Date.now() - t < maxAge) return { data: await r.json(), time: t };
        }
      }
    } catch (e) { /* fall through */ }
    const m = memCache.get(key);
    if (m && (!maxAge || Date.now() - m.time < maxAge)) return m;
    return null;
  }
  async function cachePut(key, data) {
    const time = Date.now();
    memCache.set(key, { data, time });
    try {
      if (window.caches) {
        const c = await caches.open('tm-data-v1');
        await c.put(dataUrl(key), new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'x-time': String(time) } }));
      }
    } catch (e) { /* quota or no cache */ }
  }

  /* ---------------- network ---------------- */
  async function overpass(query, timeoutMs) {
    let lastErr;
    for (const ep of OVERPASS) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs || 120000);
      try {
        const r = await fetch(ep, {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        clearTimeout(timer);
        if (r.status === 400) { const e = new Error('query rejected'); e.bad = true; throw e; }
        if (!r.ok) { lastErr = new Error('busy ' + r.status); continue; }
        const j = await r.json();
        if (j.remark && /static error|parse error/i.test(j.remark)) { const e = new Error(j.remark); e.bad = true; throw e; }
        if (j.remark && /runtime error|timed out|out of memory/i.test(j.remark) && !(j.elements || []).length) { lastErr = new Error(j.remark); continue; }
        return j;
      } catch (e) { clearTimeout(timer); if (e.bad) throw e; lastErr = e; }
    }
    throw lastErr || new Error('No map data service answered');
  }
  async function geocode(q) {
    const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&bounded=1&viewbox=' +
      SF_VIEWBOX + '&q=' + encodeURIComponent(q);
    const r = await fetch(u, { headers: { 'Accept-Language': 'en' } });
    if (!r.ok) throw new Error('Search is busy');
    return r.json();
  }

  /* ---------------- geometry ---------------- */
  const R = 6371008.8, RAD = Math.PI / 180;
  function hav(a1, o1, a2, o2) {
    const dA = (a2 - a1) * RAD, dO = (o2 - o1) * RAD;
    const s = Math.sin(dA / 2) ** 2 + Math.cos(a1 * RAD) * Math.cos(a2 * RAD) * Math.sin(dO / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function makeProj(lat0, lon0) {
    const kx = Math.cos(lat0 * RAD) * R * RAD, ky = R * RAD;
    return { x: (lon) => (lon - lon0) * kx, y: (lat) => (lat - lat0) * ky, lon: (x) => x / kx + lon0, lat: (y) => y / ky + lat0 };
  }
  // segs: Float64Array of x1,y1,x2,y2 quads. Returns nearest point info.
  function nearestOnSegs(px, py, segs, idx) {
    let best = Infinity, bx = 0, by = 0, bi = -1, bt = 0;
    const list = idx || null, n = list ? list.length : segs.length / 4;
    for (let k = 0; k < n; k++) {
      const i = list ? list[k] : k, o = i * 4;
      const x1 = segs[o], y1 = segs[o + 1], dx = segs[o + 2] - x1, dy = segs[o + 3] - y1;
      const L2 = dx * dx + dy * dy;
      let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = x1 + t * dx, qy = y1 + t * dy, d = (px - qx) ** 2 + (py - qy) ** 2;
      if (d < best) { best = d; bx = qx; by = qy; bi = i; bt = t; }
    }
    return { d: Math.sqrt(best), x: bx, y: by, i: bi, t: bt };
  }
  function bearingName(a1, o1, a2, o2) {
    const y = Math.sin((o2 - o1) * RAD) * Math.cos(a2 * RAD);
    const x = Math.cos(a1 * RAD) * Math.sin(a2 * RAD) - Math.sin(a1 * RAD) * Math.cos(a2 * RAD) * Math.cos((o2 - o1) * RAD);
    const deg = (Math.atan2(y, x) / RAD + 360) % 360;
    return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(deg / 45) % 8];
  }
  // Simple binary heap for Dijkstra.
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], last = k.length - 1;
      [k[0], k[last]] = [k[last], k[0]]; [v[0], v[last]] = [v[last], v[0]]; k.pop(); v.pop();
      let i = 0; const n = k.length;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < n && k[l] < k[m]) m = l; if (r < n && k[r] < k[m]) m = r; if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; }
      return top;
    }
  }

  /* ---------------- formatting ---------------- */
  const fmtMi = (m) => { const mi = m / 1609.344; return mi < 0.1 ? Math.round(m * 3.28084) + ' ft' : (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi'; };
  const fmtOff = (m) => Math.round(m * 3.28084) + ' ft (' + Math.round(m) + ' m)';
  const SURF_WORD = {
    sand: 'sand', ground: 'dirt', dirt: 'dirt', earth: 'dirt', mud: 'mud', grass: 'grass', gravel: 'gravel',
    fine_gravel: 'fine gravel', compacted: 'packed gravel', shells: 'shell rock', shell: 'shell rock', crushed_limestone: 'limerock',
    rock: 'rock', unpaved: 'unpaved', wood: 'boardwalk', asphalt: 'paved', concrete: 'paved', paved: 'paved', paving_stones: 'pavers',
    woodchips: 'woodchips', pebblestone: 'gravel', boardwalk: 'boardwalk', metal: 'metal walkway',
  };
  function surfClass(t) {
    const s = (t.surface || '').split(';')[0];
    if (t.bridge === 'boardwalk' || t.man_made === 'pier' || t.boardwalk === 'yes' || /^(wood|metal|metal_grid|plastic|boardwalk)$/.test(s)) return 'board';
    if (/^(asphalt|concrete|concrete:plates|concrete:lanes|paved|paving_stones|sett|chipseal|bricks|brick|cobblestone|rubber|tartan|unhewn_cobblestone)$/.test(s)) return 'paved';
    if (s) return 'nat';
    if (t.highway === 'track') return 'nat';
    if (t.bridge === 'yes') return 'board';
    return 'unk';
  }
  function surfWord(t) {
    const c = surfClass(t);
    if (c === 'board') return 'boardwalk';
    const s = (t.surface || '').split(';')[0];
    if (s) return SURF_WORD[s] || s.replace(/_/g, ' ');
    if (c === 'nat') return 'unpaved';
    return 'surface not mapped';
  }
  function difficulty(stats) {
    // Estimate only: OSM rarely tags difficulty in Florida, so judge from surface and length.
    const tot = stats.total || 1, easy = (stats.board + stats.paved) / tot;
    if (easy > 0.8) return 'Easy';
    if (stats.total > 8000 && stats.nat / tot > 0.5) return 'Moderate';
    return 'Easy to moderate';
  }
  const areaKey = (a) => a.type[0] + a.id;

  /* ---------------- state ---------------- */
  const S = {
    center: null, radius: store.get('radius', 24140), list: [], favs: store.get('favs', {}), mode: store.get('mode', 'trails') === 'parks' ? 'parks' : 'trails',
    hike: null, hikeTimer: null, trackLine: null,
    area: null, model: null, map: null, layers: null, selected: null,
    watchId: null, me: null, follow: false, offCount: 0, off: false, lastAlert: 0, wake: null, audio: null,
    routeLayer: null, offLine: null, meMarker: null, accCircle: null, lastFix: null,
  };

  /* ================= FIND VIEW ================= */
  const findStatus = (msg, err) => { const s = $('#findStatus'); s.textContent = msg || ''; s.classList.toggle('err', !!err); };

  // level 2: per-trail names, lengths and surfaces; level 1: trail names only; level 0: totals only.
  // The app falls back a level if the map service rejects the richer request.
  function discoveryQuery(lat, lon, r, level) {
    if (level == null) level = 2;
    const ar = `(around:${r},${lat.toFixed(5)},${lon.toFixed(5)})`;
    const perTrail = level >= 2 ? `
 way.w[name];
 for (t["name"])(
  make trail name=_.val,m=sum(length()),s=set(t["surface"]),b=set(t["bridge"]);
  out;
 );` : '';
    const names = level >= 1 ? ',names=set(t["name"])' : '';
    return `[out:json][timeout:170];
(
 way[leisure=nature_reserve]${ar}; relation[leisure=nature_reserve]${ar};
 way[boundary=protected_area]${ar}; relation[boundary=protected_area]${ar};
 way[boundary=national_park]${ar}; relation[boundary=national_park]${ar};
 way[leisure=park][name]${ar}; relation[leisure=park][name]${ar};
 way[natural~"^(wetland|wood|scrub|heath)$"][name]${ar}; relation[natural~"^(wetland|wood|scrub|heath)$"][name]${ar};
)->.c;
foreach.c->.p(
 .p out tags center bb;
 .p map_to_area->.a;
 way(area.a)[highway~"${TRAIL_HW}"]${NOT_SIDEWALK}->.w;
 way.w[~"^(surface|bridge|man_made)$"~"${EASY_RX}"];
 make estat m=sum(length());
 out;${perTrail}
 (.w;);
 make tstat n=count(ways),m=sum(length())${names};
 out;
);
relation[route~"^(hiking|foot)$"]${ar}->.h;
foreach.h->.p(
 .p out tags center bb;
 way(r.p)->.w;
 way.w[~"^(surface|bridge|man_made)$"~"${EASY_RX}"];
 make estat m=sum(length());
 out;
 (.w;);
 make tstat n=count(ways),m=sum(length());
 out;
);`;
  }

  const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const splitSet = (v) => String(v || '').split(';').map((x) => x.trim()).filter(Boolean);

  function parseDiscovery(json) {
    const out = []; let cur = null, easy = 0, trails = [];
    for (const e of json.elements || []) {
      const t = e.tags || {};
      if (e.type === 'estat') { easy = +t.m || 0; continue; }
      if (e.type === 'trail') { if (t.name) trails.push({ name: t.name, m: +t.m || 0, s: splitSet(t.s), b: splitSet(t.b) }); continue; }
      if (e.type === 'tstat') {
        if (cur) {
          cur.n = +t.n || 0; cur.m = +t.m || 0; cur.easy = easy;
          if (trails.length) cur.trails = trails;
          else if (t.names != null) cur.trails = splitSet(t.names).map((name) => ({ name, m: 0, s: [], b: [] }));
          else cur.trails = null; // this map service gave totals only
          out.push(cur);
        }
        cur = null; easy = 0; trails = []; continue;
      }
      const c = e.center || (e.bounds ? { lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lon: (e.bounds.minlon + e.bounds.maxlon) / 2 } : null);
      trails = []; easy = 0;
      if (!c) { cur = null; continue; }
      cur = {
        type: e.type, id: e.id, name: t.name || t['name:en'] || t.official_name || '', lat: c.lat, lon: c.lon,
        bb: e.bounds ? [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon] : null,
        kind: t.route ? 'route' : (t.leisure === 'park' && !t.boundary ? 'park' : 'nature'),
        operator: t.operator || '',
      };
    }
    // Keep areas with real trail mileage; city parks need more to count as a trail.
    const keep = out.filter((a) => a.name && a.n > 0 && a.m >= (a.kind === 'park' ? 800 : 150));
    const byName = new Map();
    for (const a of keep) {
      const k = normName(a.name);
      const b = byName.get(k);
      if (!b || a.m > b.m) byName.set(k, a);
    }
    const areas = [...byName.values()];
    // A long-distance route is itself one trail.
    for (const a of areas) if (a.kind === 'route') a.trails = [{ name: a.name, m: a.m, s: [], b: [] }];
    return areas;
  }

  // Same trail if the two areas overlap (or, with no outline, their centres are close).
  const sameSpot = (x, y) => {
    const a = x.bb, b = y.bb;
    if (a && b) return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
    return hav(x.lat, x.lon, y.lat, y.lon) < 3000;
  };
  const bbSpan = (b) => (b ? hav(b[0], b[1], b[2], b[3]) : 0);
  const EASY_S = /^(asphalt|concrete|paved|paving_stones|wood|boardwalk|metal|concrete:plates|concrete:lanes)$/;

  // One row per named trail. The same trail inside two overlapping areas (a preserve inside a
  // national park, say) is listed once, under the area where more of it lies.
  function trailRows(areas) {
    const rows = [];
    for (const a of areas) {
      if (!a.trails) continue;
      const named = a.trails.filter((t) => t.name);
      if (!named.length) { rows.push({ area: a, name: '', m: a.m, cls: a.m && a.easy / a.m > 0.5 ? 'easy' : 'nat' }); continue; }
      for (const t of named) {
        const easyS = t.s.length && t.s.every((x) => EASY_S.test(x));
        const cls = t.b.includes('boardwalk') || easyS ? 'easy' : t.s.length ? 'nat' : 'unk';
        rows.push({ area: a, name: t.name, m: t.m, cls });
      }
    }
    const kept = [];
    for (const r of rows) {
      const k = normName(r.name);
      const dup = r.name ? kept.find((x) => normName(x.name) === k && sameSpot(x.area, r.area)) : null;
      if (!dup) { kept.push(r); continue; }
      if (r.m > dup.m || (r.m === dup.m && bbSpan(r.area.bb) < bbSpan(dup.area.bb))) kept[kept.indexOf(dup)] = r;
    }
    return kept;
  }

  async function discover(lat, lon, label) {
    S.center = { lat, lon, label };
    store.set('center', S.center);
    const r = S.radius;
    const key = `disc2:${lat.toFixed(2)},${lon.toFixed(2)},${r}`;
    $('#areaList').replaceChildren();
    const hit = await cacheGet(key, 7 * DAY);
    if (hit) { S.list = hit.data; renderList(); findStatus(listSummary(r, label) + ` Saved list from ${new Date(hit.time).toLocaleDateString()}.`); return; }
    findStatus(`Looking for trails within ${fmtMi(r)} of ${label}. Big searches can take a minute.`);
    try {
      let j = null, err = null;
      for (const level of [2, 1, 0]) {
        try { j = await overpass(discoveryQuery(lat, lon, r, level), 190000); break; }
        catch (e) { err = e; if (!e.bad) break; }
      }
      if (!j) throw err;
      S.list = parseDiscovery(j);
      await cachePut(key, S.list);
      renderList();
      findStatus(S.list.length ? listSummary(r, label) : `No mapped trails found within ${fmtMi(r)} of ${label}. Try a bigger radius.`);
    } catch (e) {
      findStatus('The trail data service is busy or out of reach. Check your signal and try again in a minute.', true);
    }
  }

  function listSummary(r, label) {
    const nT = trailRows(S.list).length;
    return S.mode === 'parks' || !S.list.some((a) => a.trails)
      ? `${S.list.length} parks and preserves with trails within ${fmtMi(r)} of ${label}.`
      : `${nT} trails in ${S.list.length} parks and preserves within ${fmtMi(r)} of ${label}.`;
  }

  function surfTag(cls) {
    if (cls === 'easy') return el('span', { class: 'tag' }, [el('i', { style: 'background:var(--board)' }), 'Boardwalk or paved']);
    if (cls === 'nat') return el('span', { class: 'tag' }, [el('i', { style: 'background:var(--nat)' }), 'Natural ground']);
    return el('span', { class: 'tag' }, [el('i', { style: 'background:var(--unk)' }), 'Surface not mapped']);
  }

  function areaCard(a, onOpen) {
    const k = areaKey(a), fav = !!S.favs[k];
    const d = S.center ? hav(S.center.lat, S.center.lon, a.lat, a.lon) : null;
    const easyShare = a.m ? a.easy / a.m : 0;
    const nT = a.trails ? a.trails.filter((t) => t.name).length : 0;
    const meta = el('div', { class: 'meta' }, [
      el('span', { class: 'tag', text: fmtMi(a.m) + ' of mapped paths' }),
      nT ? el('span', { class: 'tag', text: nT + ' named trail' + (nT === 1 ? '' : 's') }) : null,
      easyShare > 0.5 ? el('span', { class: 'tag' }, [el('i', { style: 'background:var(--board)' }), 'Mostly boardwalk or paved'])
        : easyShare > 0.1 ? el('span', { class: 'tag' }, [el('i', { style: 'background:var(--board)' }), 'Some boardwalk or paved'])
          : el('span', { class: 'tag' }, [el('i', { style: 'background:var(--nat)' }), 'Natural ground']),
      a.kind === 'route' ? el('span', { class: 'tag', text: 'Long-distance route' }) : null,
      fav ? el('span', { class: 'tag' }, [el('span', { class: 'fav', text: '★' }), 'Favorite']) : null,
    ]);
    const b = el('button', { class: 'area', type: 'button', onclick: () => onOpen(a) }, [
      el('h3', { text: a.name }),
      d != null ? el('span', { class: 'dist', text: fmtMi(d) }) : null,
      meta,
    ]);
    return el('li', null, [b]);
  }

  function trailCard(row) {
    const a = row.area, fav = !!S.favs[areaKey(a)];
    const d = S.center ? hav(S.center.lat, S.center.lon, a.lat, a.lon) : null;
    const meta = el('div', { class: 'meta' }, [
      el('span', { class: 'tag park', text: row.name ? a.name : 'Paths without a trail name' }),
      row.m ? el('span', { class: 'tag', text: fmtMi(row.m) + ' mapped' }) : null,
      surfTag(row.cls),
      fav ? el('span', { class: 'tag' }, [el('span', { class: 'fav', text: '★' }), 'Favorite']) : null,
    ]);
    const b = el('button', { class: 'area trail', type: 'button', onclick: () => openArea(a, false, row.name || '__unnamed') }, [
      el('h3', { text: row.name || 'Paths at ' + a.name }),
      d != null ? el('span', { class: 'dist', title: 'Distance to the park', text: fmtMi(d) }) : null,
      meta,
    ]);
    return el('li', null, [b]);
  }

  function setMode(mode) {
    S.mode = mode; store.set('mode', mode);
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  }

  function renderList() {
    const surf = $('#surfFilter').value, sort = $('#sortBy').value, favOnly = $('#favOnly').checked;
    const c = S.center;
    const dist = (a) => (c ? hav(c.lat, c.lon, a.lat, a.lon) : 0);
    const hasTrails = S.list.some((a) => a.trails);
    if (S.mode === 'parks' || !hasTrails) {
      let L = S.list.slice();
      if (surf === 'easy') L = L.filter((a) => a.m && a.easy / a.m > 0.5);
      if (surf === 'natural') L = L.filter((a) => a.m && a.easy / a.m < 0.5);
      if (favOnly) L = L.filter((a) => S.favs[areaKey(a)]);
      if (sort === 'dist' && c) L.sort((x, y) => dist(x) - dist(y));
      if (sort === 'len') L.sort((x, y) => y.m - x.m);
      if (sort === 'name') L.sort((x, y) => x.name.localeCompare(y.name));
      $('#areaList').replaceChildren(...L.map((a) => areaCard(a, openArea)));
    } else {
      let T = trailRows(S.list);
      if (surf === 'easy') T = T.filter((t) => t.cls === 'easy');
      if (surf === 'natural') T = T.filter((t) => t.cls === 'nat');
      if (favOnly) T = T.filter((t) => S.favs[areaKey(t.area)]);
      const nm = (t) => t.name || 'Paths at ' + t.area.name;
      if (sort === 'dist' && c) T.sort((x, y) => dist(x.area) - dist(y.area) || y.m - x.m);
      if (sort === 'len') T.sort((x, y) => y.m - x.m);
      if (sort === 'name') T.sort((x, y) => nm(x).localeCompare(nm(y)));
      $('#areaList').replaceChildren(...T.slice(0, 400).map(trailCard));
    }
    renderSaved();
  }

  function renderSaved() {
    const saved = store.get('saved', []);
    $('#savedBlock').hidden = !saved.length;
    $('#savedList').replaceChildren(...saved.map((a) => areaCard(a, openArea)));
  }

  function setRadius(r) {
    S.radius = r; store.set('radius', r);
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(+c.dataset.r === r)));
  }

  function locateOnce() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('This browser has no location.'));
      navigator.geolocation.getCurrentPosition((p) => res(p.coords), (e) => rej(e), { enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 });
    });
  }

  function locError(e) {
    if (e && e.code === 1) return 'Location is turned off for this app. Allow location in your browser settings, or search a place instead.';
    if (e && e.code === 3) return 'Your phone took too long to find you. Step outside or try again.';
    return 'Your location isn\'t available right now. Search a place instead.';
  }

  async function nearMe() {
    findStatus('Finding where you are...');
    try { const c = await locateOnce(); await discover(c.latitude, c.longitude, 'you'); }
    catch (e) { findStatus(locError(e), true); }
  }

  async function onSearch(ev) {
    ev.preventDefault();
    const q = $('#searchInput').value.trim();
    const box = $('#searchResults');
    if (!q) return;
    box.hidden = false; box.replaceChildren(el('p', { class: 'status', text: 'Searching...' }));
    try {
      const res = await geocode(q);
      if (!res.length) { box.replaceChildren(el('p', { class: 'status', text: 'Nothing found in South Florida for that. Try a park name, city or zip.' })); return; }
      box.replaceChildren(...res.map((r) => {
        const isArea = (r.osm_type === 'way' || r.osm_type === 'relation') && /^(leisure|boundary|natural|landuse)$/.test(r.category);
        const lat = +r.lat, lon = +r.lon, name = r.name || r.display_name.split(',')[0];
        const bbx = r.boundingbox ? [+r.boundingbox[0], +r.boundingbox[2], +r.boundingbox[1], +r.boundingbox[3]] : null;
        return el('button', {
          type: 'button',
          onclick: () => {
            box.hidden = true;
            if (isArea) openArea({ type: r.osm_type, id: r.osm_id, name, lat, lon, bb: bbx, kind: 'nature', m: 0, easy: 0 });
            else discover(lat, lon, name);
          },
        }, [el('span', { text: name }), el('small', { text: isArea ? 'Open this trail map' : 'Find trails near here · ' + r.display_name.split(',').slice(1, 3).join(',') })]);
      }));
    } catch (e) {
      box.replaceChildren(el('p', { class: 'status err', text: 'Search is out of reach right now. Check your signal and try again.' }));
    }
  }

  /* ================= AREA VIEW ================= */
  const areaStatus = (msg, err) => { const s = $('#areaStatus'); s.textContent = msg || ''; s.classList.toggle('err', !!err); };

  function areaQuery(a, useBbox) {
    let sel;
    if (a.kind === 'route' && a.type === 'relation') sel = `relation(${a.id});way(r)->.t;`;
    else if (useBbox && a.bb) {
      const b = a.bb.map((v) => v.toFixed(6)).join(',');
      sel = `(way(${b})[highway~"${TRAIL_HW}"]${NOT_SIDEWALK};way(${b})[man_made=pier];)->.t;`;
    } else {
      sel = `${a.type}(${a.id});map_to_area->.a;(way(area.a)[highway~"${TRAIL_HW}"]${NOT_SIDEWALK};way(area.a)[man_made=pier];)->.t;`;
    }
    return `[out:json][timeout:120];
${sel}
.t out meta;
.t >;
out skel qt;
(
 nwr(around.t:250)[amenity=parking][access!~"^(private|no)$"];
 node(around.t:60)[highway=trailhead];
 nwr(around.t:80)[amenity=toilets];
 node(around.t:40)[tourism=information][information~"^(board|map)$"];
 nwr(around.t:40)[man_made=tower]["tower:type"=observation];
);
out center tags;
${a.type}(${a.id});
out tags center bb;`;
  }

  // Works out from the mapped lines alone whether a trail is a loop, a line or a network,
  // and whether its mapped pieces join up. Nothing here is guessed or drawn in.
  function groupShape(g, ways) {
    const deg = new Map(), parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
    let latest = '', steps = false, informal = false, desc = '', wcYes = 0, wcNo = 0, sac = '';
    for (const wi of g.ways) {
      const w = ways[wi], t = w.tags;
      if (w.ts > latest) latest = w.ts;
      if (t.highway === 'steps') steps = true;
      if (t.informal === 'yes') informal = true;
      if (!desc && t.description) desc = t.description;
      if (!sac && t.sac_scale) sac = t.sac_scale;
      if (t.wheelchair === 'yes') wcYes += w.len; else if (t.wheelchair === 'no') wcNo += w.len;
      for (let k = 1; k < w.ni.length; k++) {
        const u = w.ni[k - 1], v = w.ni[k]; if (u === v) continue;
        add(u); add(v);
        deg.set(u, (deg.get(u) || 0) + 1); deg.set(v, (deg.get(v) || 0) + 1);
        const ru = find(u), rv = find(v); if (ru !== rv) parent.set(ru, rv);
      }
    }
    const roots = new Set(); let odd = 0, maxDeg = 0;
    for (const [n, d] of deg) { roots.add(find(n)); if (d % 2) odd++; if (d > maxDeg) maxDeg = d; }
    const pieces = roots.size;
    let shape = 'network';
    if (pieces === 1 && odd === 0) shape = 'loop';
    else if (pieces === 1 && odd === 2 && maxDeg <= 2) shape = 'line';
    else if (pieces === 1 && odd === 2) shape = 'lollipop';
    return { pieces, shape, latest, steps, informal, desc, sac, wheelchair: wcYes >= g.len * 0.9 ? 'yes' : wcNo > 0 ? 'no' : '' };
  }

  function buildModel(a, json) {
    const nodes = new Map(), ways = [], pois = [];
    let info = null;
    for (const e of json.elements || []) {
      if (e.type === 'node' && e.lat != null) nodes.set(e.id, [e.lat, e.lon]);
    }
    for (const e of json.elements || []) {
      const t = e.tags || {};
      if (e.type === a.type && e.id === a.id && (e.center || e.bounds) && !t.amenity) { info = e; continue; }
      if (e.type === 'way' && !e.center && e.nodes) { ways.push({ id: e.id, nodes: e.nodes, tags: t, ts: e.timestamp || '' }); continue; }
      if (!e.tags) continue;
      const c = e.type === 'node' ? { lat: e.lat, lon: e.lon } : e.center;
      if (!c) continue;
      let kind = null;
      if (t.amenity === 'parking') kind = 'parking';
      else if (t.highway === 'trailhead') kind = 'trailhead';
      else if (t.amenity === 'toilets') kind = 'toilets';
      else if (t.tourism === 'information') kind = 'info';
      else if (t.man_made === 'tower') kind = 'tower';
      if (kind) pois.push({ kind, lat: c.lat, lon: c.lon, name: t.name || '' });
    }
    if (!ways.length) return null;
    // projection around the trail network
    let la = 0, lo = 0, cnt = 0;
    for (const w of ways) for (const id of w.nodes) { const p = nodes.get(id); if (p) { la += p[0]; lo += p[1]; cnt++; } }
    const proj = makeProj(la / cnt, lo / cnt);
    // graph + segments
    const idx = new Map(), coords = [];
    const nodeIndex = (id) => { let i = idx.get(id); if (i === undefined) { const p = nodes.get(id); i = coords.length; idx.set(id, i); coords.push(p); } return i; };
    const adj = [], segList = [], segWay = [];
    const stats = { total: 0, board: 0, paved: 0, nat: 0, unk: 0 };
    const groups = new Map();
    ways.forEach((w, wi) => {
      w.cls = surfClass(w.tags); w.surf = surfWord(w.tags); w.len = 0; w.ll = []; w.ni = [];
      let prev = null;
      for (const id of w.nodes) {
        const p = nodes.get(id); if (!p) { prev = null; continue; }
        const i = nodeIndex(id); w.ll.push(p); w.ni.push(i);
        if (prev !== null && prev !== i) {
          const q = coords[prev], d = hav(q[0], q[1], p[0], p[1]);
          (adj[prev] || (adj[prev] = [])).push(i, d);
          (adj[i] || (adj[i] = [])).push(prev, d);
          segList.push(proj.x(q[1]), proj.y(q[0]), proj.x(p[1]), proj.y(p[0])); segWay.push(wi);
          w.len += d;
        }
        prev = i;
      }
      stats.total += w.len; stats[w.cls] += w.len;
      const gname = w.tags.name || w.tags.ref || '';
      const key = gname || '__unnamed';
      let g = groups.get(key);
      if (!g) { g = { key, name: gname || 'Unnamed paths', len: 0, surf: new Map(), cls: { board: 0, paved: 0, nat: 0, unk: 0, total: 0 }, ways: [], segs: [] }; groups.set(key, g); }
      g.len += w.len; g.ways.push(wi); g.surf.set(w.surf, (g.surf.get(w.surf) || 0) + w.len);
      g.cls[w.cls] += w.len; g.cls.total += w.len;
    });
    const segs = new Float64Array(segList);
    segWay.forEach((wi, si) => { const w = ways[wi]; const key = (w.tags.name || w.tags.ref || '') || '__unnamed'; groups.get(key).segs.push(si); });
    const groupList = [...groups.values()].sort((x, y) => (x.key === '__unnamed') - (y.key === '__unnamed') || y.len - x.len);
    for (const g of groupList) { g.segIdx = Int32Array.from(g.segs); Object.assign(g, groupShape(g, ways)); }
    const parking = pois.filter((p) => p.kind === 'parking');
    const t = (info && info.tags) || {};
    return {
      area: a, ways, coords, adj, segs, segWay, proj, stats, groups: groupList, pois, parking,
      info: { hours: t.opening_hours || '', website: t.website || t['contact:website'] || t.url || '', operator: t.operator || '', fee: t.fee || '', name: t.name || a.name },
      bounds: L.latLngBounds(ways.flatMap((w) => w.ll)),
    };
  }

  async function loadArea(a, force) {
    const key = 'area:' + areaKey(a) + (a.kind === 'route' ? ':r' : '');
    if (!force) {
      const hit = await cacheGet(key, 0);
      if (hit) {
        const m = buildModel(a, hit.data);
        if (m) { m.fetched = hit.time; if (Date.now() - hit.time > 30 * DAY) areaStatus('Trail lines saved over a month ago. Refresh them when you have signal.'); return m; }
      }
    }
    areaStatus('Loading trail lines...');
    let j = await overpass(areaQuery(a, false), 130000);
    let m = buildModel(a, j);
    if (!m && a.bb) { j = await overpass(areaQuery(a, true), 130000); m = buildModel(a, j); }
    if (!m) return null;
    await cachePut(key, j);
    m.fetched = Date.now();
    return m;
  }

  function ensureMap() {
    if (S.map) return S.map;
    const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true, tap: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, crossOrigin: true,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    map.on('dragstart', () => setFollow(false));
    S.map = map;
    return map;
  }

  function drawModel(m) {
    const map = ensureMap(), C = COLORS();
    if (S.layers) S.layers.remove();
    const g = L.layerGroup().addTo(map);
    const renderer = L.canvas({ padding: 0.5, tolerance: 8 });
    const halo = L.layerGroup().addTo(g);
    m.ways.forEach((w) => {
      const color = C[w.cls];
      const line = L.polyline(w.ll, { renderer, color, weight: w.cls === 'board' ? 6 : 5, opacity: 0.95, dashArray: w.cls === 'unk' ? '6 6' : null, lineCap: 'round' });
      line.bindPopup(() => `<b>${escapeHtml(w.tags.name || 'Unnamed path')}</b><br>${escapeHtml(w.surf)} · ${fmtMi(w.len)}`);
      line.addTo(g);
    });
    m.pois.forEach((p) => {
      if (p.kind === 'parking') L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'mk-p', html: 'P', iconSize: [20, 20] }), keyboard: false }).bindPopup(escapeHtml(p.name || 'Parking')).addTo(g);
      else L.circleMarker([p.lat, p.lon], { radius: 6, color: '#fff', weight: 2, fillColor: p.kind === 'toilets' ? '#6a4fb3' : p.kind === 'trailhead' ? C.sun : '#2f6f9f', fillOpacity: 1 })
        .bindPopup({ toilets: 'Restrooms', trailhead: p.name || 'Trailhead', info: p.name || 'Map board', tower: p.name || 'Observation tower' }[p.kind]).addTo(g);
    });
    S.layers = g; S.halo = halo;
    map.invalidateSize();
    map.fitBounds(m.bounds, { padding: [30, 30], maxZoom: 17 });
  }

  function groupBounds(m, grp) { return L.latLngBounds(grp.ways.flatMap((wi) => m.ways[wi].ll)); }

  function highlightGroup(gIdx, opts) {
    const m = S.model, C = COLORS();
    opts = opts || {};
    S.halo.clearLayers();
    S.selected = gIdx;
    document.querySelectorAll('#trailList button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === gIdx)));
    const grp = gIdx == null ? null : m.groups[gIdx];
    if (grp) {
      const lines = grp.ways.map((wi) => m.ways[wi].ll);
      L.polyline(lines, { color: C.sun, weight: 12, opacity: 0.55, interactive: false }).addTo(S.halo);
      if (!opts.noFit) S.map.fitBounds(groupBounds(m, grp), { padding: [40, 40], maxZoom: 17 });
      const sel = $('#warnTarget');
      if ([...sel.options].some((o) => o.value === grp.key)) sel.value = grp.key;
      S.offCount = 0;
    } else if (!opts.noFit) S.map.fitBounds(m.bounds, { padding: [30, 30], maxZoom: 17 });
    renderTrailDetail(m, grp);
    setDirections(m, grp);
    $('#areaName').textContent = grp && grp.key !== '__unnamed' ? grp.name : (S.area && S.area.name) || m.info.name || 'Trail map';
    if (!opts.noHash && S.area) {
      const h = `#/area/${S.area.type}/${S.area.id}` + (grp ? '/t/' + encodeURIComponent(grp.key) : '');
      if (location.hash !== h) history.replaceState(null, '', h);
    }
    $('#trackBtn').textContent = S.watchId != null ? 'End trail' : grp ? 'Start this trail' : 'Start trail';
  }

  const SHAPE = {
    loop: ['Loop', 'Ends where it starts'],
    line: ['One way', 'Walk back the same way, or arrange a ride'],
    lollipop: ['Loop with a spur', 'Walk the spur both ways'],
    network: ['Several branches', 'Paths with this name branch or cross'],
  };

  function nearestPoi(m, grp, kinds) {
    let best = null, bd = Infinity;
    for (const p of m.pois) {
      if (!kinds.includes(p.kind)) continue;
      const r = nearestOnSegs(m.proj.x(p.lon), m.proj.y(p.lat), m.segs, grp ? grp.segIdx : null);
      if (r.d < bd) { bd = r.d; best = p; }
    }
    return best ? { p: best, d: bd } : null;
  }

  function surfLine(st) {
    const tot = st.total || 1, pct = (v) => Math.round((v / tot) * 100);
    return [['board', 'boardwalk'], ['paved', 'paved'], ['nat', 'natural ground'], ['unk', 'surface not mapped']]
      .filter(([k]) => st[k] / tot >= 0.05).map(([k, w]) => `${pct(st[k])}% ${w}`).join(', ');
  }

  function renderTrailDetail(m, grp) {
    const box = $('#trailDetail');
    if (!grp) { box.hidden = true; $('#areaFactsHead').textContent = 'About this area'; return; }
    box.hidden = false;
    $('#areaFactsHead').textContent = 'About the park';
    $('#tdName').textContent = grp.key === '__unnamed' ? 'Paths without a trail name' : grp.name;
    $('#tdPark').textContent = m.info.name || m.area.name || '';
    const sh = SHAPE[grp.shape];
    const lenLabel = grp.shape === 'line' ? `One way · about ${fmtMi(grp.len * 2)} there and back`
      : grp.shape === 'loop' ? 'Around the loop' : 'All mapped paths with this name';
    const facts = [
      el('div', { class: 'fact' }, [el('b', { text: fmtMi(grp.len) }), el('span', { text: lenLabel })]),
      el('div', { class: 'fact' }, [el('b', { text: grp.pieces > 1 ? 'Not joined up' : sh[0] }), el('span', { text: grp.pieces > 1 ? `Mapped in ${grp.pieces} pieces` : sh[1] })]),
      el('div', { class: 'fact' }, [el('b', { text: difficulty(grp.cls) }), el('span', { text: 'Difficulty (estimate)' })]),
      el('div', { class: 'fact wide' }, [el('b', { text: surfLine(grp.cls) || 'Surface not mapped' }), el('span', { text: 'Surface' })]),
    ];
    if (grp.wheelchair === 'yes') facts.push(el('div', { class: 'fact' }, [el('b', { text: 'Yes' }), el('span', { text: 'Wheelchair (as mapped)' })]));
    if (grp.wheelchair === 'no') facts.push(el('div', { class: 'fact' }, [el('b', { text: 'Not suitable' }), el('span', { text: 'Wheelchair (as mapped)' })]));
    if (grp.steps) facts.push(el('div', { class: 'fact' }, [el('b', { text: 'Has steps' }), el('span', { text: 'Stairs on the route' })]));
    const start = nearestPoi(m, grp, ['parking']) || nearestPoi(m, grp, ['trailhead']);
    if (start) facts.push(el('div', { class: 'fact wide' }, [el('b', { text: `${start.p.name || (start.p.kind === 'parking' ? 'Parking lot' : 'Trailhead')}, ${fmtMi(start.d)} from the trail` }), el('span', { text: start.p.kind === 'parking' ? 'Nearest mapped parking' : 'Nearest mapped trailhead' })]));
    const wc = nearestPoi(m, grp, ['toilets']);
    facts.push(el('div', { class: 'fact wide' }, [el('b', { text: wc && wc.d < 400 ? `Mapped ${fmtMi(wc.d)} from the trail` : 'None mapped near this trail' }), el('span', { text: 'Restrooms' })]));
    if (grp.desc) facts.push(el('div', { class: 'fact wide' }, [el('b', { text: grp.desc }), el('span', { text: 'Note on the map' })]));
    $('#tdFacts').replaceChildren(...facts);

    const notes = [];
    if (grp.pieces > 1) notes.push(`This trail is mapped in ${grp.pieces} pieces that don't join up. The gaps may be stretches nobody has mapped yet, so follow the park's signs there.`);
    const unk = grp.cls.unk / (grp.cls.total || 1);
    if (unk >= 0.2) notes.push(`The surface of ${Math.round(unk * 100)}% of this trail isn't mapped. Those parts show as a dashed line.`);
    if (grp.informal) notes.push('Part of this is mapped as an informal path, not an official trail.');
    if (grp.latest) {
      const yrs = (Date.now() - Date.parse(grp.latest)) / (365.25 * DAY);
      notes.push(`Trail line last edited on the map in ${new Date(grp.latest).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}.` + (yrs > 5 ? ' That\'s a while ago, so check it against the park\'s map.' : ''));
    }
    if (grp.key === '__unnamed') notes.push('These paths have no trail name on the map. They may be service roads or side paths.');
    notes.push('The line is drawn only from what\'s mapped on OpenStreetMap. Nothing is guessed or filled in.');
    $('#tdNotes').replaceChildren(...notes.map((n) => el('li', { text: n })));
  }

  function setDirections(m, grp) {
    const near = grp ? (nearestPoi(m, grp, ['parking']) || nearestPoi(m, grp, ['trailhead'])) : null;
    const best = near ? near.p : bestParking(m);
    const dir = $('#dirLink');
    if (best) { dir.href = `https://www.google.com/maps/dir/?api=1&destination=${best.lat.toFixed(6)},${best.lon.toFixed(6)}`; dir.textContent = best.kind === 'parking' ? 'Directions to parking' : 'Directions to trailhead'; }
    else { const c = (grp ? groupBounds(m, grp) : m.bounds).getCenter(); dir.href = `https://www.google.com/maps/dir/?api=1&destination=${c.lat.toFixed(6)},${c.lng.toFixed(6)}`; dir.textContent = grp ? 'Directions to this trail' : 'Directions to this area'; }
  }

  function renderSheet(m) {
    const st = m.stats;
    const facts = [
      el('div', { class: 'fact' }, [el('b', { text: fmtMi(st.total) }), el('span', { text: 'Mapped paths' })]),
      el('div', { class: 'fact' }, [el('b', { text: String(m.groups.filter((g) => g.key !== '__unnamed').length) }), el('span', { text: 'Named trails' })]),
      el('div', { class: 'fact wide' }, [el('b', { text: surfLine(st) || 'Surface not mapped' }), el('span', { text: 'Surface, all paths' })]),
    ];
    if (m.info.hours) facts.push(el('div', { class: 'fact wide' }, [el('b', { text: m.info.hours.replace(/;\s*/g, '; ') }), el('span', { text: 'Hours listed on OpenStreetMap, check the park site' })]));
    if (m.info.fee === 'yes') facts.push(el('div', { class: 'fact wide' }, [el('b', { text: 'Entry fee charged' }), el('span', { text: 'Fee' })]));
    if (m.info.operator) facts.push(el('div', { class: 'fact wide' }, [el('b', { text: m.info.operator }), el('span', { text: 'Run by' })]));
    if (m.info.website && /^https?:\/\//.test(m.info.website)) {
      const a = el('a', { href: m.info.website, target: '_blank', rel: 'noopener', text: 'Park website' });
      facts.push(el('div', { class: 'fact wide' }, [el('b', null, [a]), el('span', { text: 'Hours, closures and rules' })]));
    }
    $('#facts').replaceChildren(...facts);

    const C = COLORS();
    $('#trailList').replaceChildren(...m.groups.map((g, i) => {
      const top = [...g.surf.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map((e) => e[0]).join(', ');
      const w0 = m.ways[g.ways[0]];
      const shape = g.pieces > 1 ? 'not joined up' : SHAPE[g.shape][0].toLowerCase();
      return el('li', null, [el('button', { type: 'button', 'aria-pressed': 'false', onclick: () => { highlightGroup(S.selected === i ? null : i); $('#sheet').scrollTop = 0; $('.sheet-body').scrollTop = 0; } }, [
        el('i', { style: `background:${C[w0.cls]}` }),
        el('span', { class: 'nm' }, [g.key === '__unnamed' ? 'Paths without a trail name' : g.name, el('small', { text: top + ' · ' + shape })]),
        el('span', { class: 'ln', text: fmtMi(g.len) }),
      ])]);
    }));

    const sel = $('#warnTarget');
    sel.replaceChildren(el('option', { value: 'all', text: 'Any mapped path here' }),
      ...m.groups.map((g) => el('option', { value: g.key, text: g.key === '__unnamed' ? 'Paths without a trail name' : g.name })));
    const saved = store.get('warn:' + areaKey(m.area), 'all');
    if ([...sel.options].some((o) => o.value === saved)) sel.value = saved;

    setDirections(m, null);
    $('#homeBtn').disabled = !m.parking.length && !m.pois.some((p) => p.kind === 'trailhead');
    const age = Math.round((Date.now() - m.fetched) / DAY);
    const nNamed = m.groups.filter((g) => g.key !== '__unnamed').length;
    areaStatus(`${nNamed} named trail${nNamed === 1 ? '' : 's'} mapped. Pick one below. Trail lines ${age < 1 ? 'downloaded today' : 'saved ' + age + ' day' + (age === 1 ? '' : 's') + ' ago'}.`);
  }

  function bestParking(m) {
    if (!m.parking.length) return null;
    // the lot closest to the trail network
    let best = null, bd = Infinity;
    for (const p of m.parking) {
      const r = nearestOnSegs(m.proj.x(p.lon), m.proj.y(p.lat), m.segs);
      if (r.d < bd) { bd = r.d; best = p; }
    }
    return best;
  }

  function findGroup(m, key) {
    if (!key) return -1;
    let i = m.groups.findIndex((g) => g.key === key);
    if (i < 0) i = m.groups.findIndex((g) => normName(g.key) === normName(key));
    return i;
  }

  async function openArea(a, fromHash, trailKey) {
    stopTracking(true);
    clearHike();
    S.area = a;
    $('#viewFind').hidden = true; $('#viewArea').hidden = false;
    $('#areaName').textContent = a.name || 'Trail map';
    setFav();
    if (!fromHash) { const h = `#/area/${a.type}/${a.id}` + (trailKey ? '/t/' + encodeURIComponent(trailKey) : ''); if (location.hash !== h) history.pushState(null, '', h); }
    $('#trailDetail').hidden = true;
    if (trailKey && trailKey !== '__unnamed') $('#areaName').textContent = trailKey;
    store.set('last', a);
    const map = ensureMap();
    setTimeout(() => map.invalidateSize(), 50);
    if (S.layers) { S.layers.remove(); S.layers = null; }
    clearRoute();
    $('#facts').replaceChildren(); $('#trailList').replaceChildren();
    if (a.bb) map.fitBounds([[a.bb[0], a.bb[1]], [a.bb[2], a.bb[3]]]); else map.setView([a.lat, a.lon], 15);
    try {
      const m = await loadArea(a, false);
      if (S.area !== a) return;
      if (!m) { areaStatus('No trails are mapped in this area on OpenStreetMap yet. Use the park\'s own map.', true); return; }
      S.model = m;
      if (!a.name && m.info.name) a.name = m.info.name;
      $('#areaName').textContent = a.name || 'Trail map';
      drawModel(m); renderSheet(m); rememberSaved(a, m);
      S.selected = null;
      const gi = findGroup(m, trailKey);
      if (gi >= 0) highlightGroup(gi, { noHash: true });
      else {
        highlightGroup(null, { noFit: true, noHash: true });
        if (trailKey && trailKey !== '__unnamed') areaStatus(`"${trailKey}" isn't in the trail lines downloaded for this park. Pick a trail below.`, true);
        $('#areaName').textContent = a.name || m.info.name || 'Trail map';
      }
    } catch (e) {
      areaStatus('Couldn\'t download the trail lines. Check your signal and tap Refresh trail data.', true);
    }
  }

  function rememberSaved(a, m) {
    const entry = { type: a.type, id: a.id, name: a.name, lat: a.lat || m.bounds.getCenter().lat, lon: a.lon || m.bounds.getCenter().lng, kind: a.kind, m: m.stats.total, easy: m.stats.board + m.stats.paved, bb: a.bb || null };
    const saved = store.get('saved', []).filter((s) => areaKey(s) !== areaKey(a));
    saved.unshift(entry);
    store.set('saved', saved.slice(0, 25));
  }

  function setFav() {
    const on = !!(S.area && S.favs[areaKey(S.area)]);
    const b = $('#favBtn'); b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
  }

  function backToFind() {
    stopTracking(true);
    clearHike();
    $('#viewArea').hidden = true; $('#viewFind').hidden = false;
    S.area = null; S.model = null;
    renderList();
  }

  /* ---------------- live tracking ---------------- */
  function setFollow(on) { S.follow = on; $('#followBtn').setAttribute('aria-pressed', String(on)); if (on && S.me) S.map.setView(S.me, Math.max(S.map.getZoom(), 17)); }

  async function wakeLock() {
    try { if ('wakeLock' in navigator && !S.wake && S.watchId != null) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } } catch (e) { /* not granted */ }
  }

  function beep() {
    if (!$('#soundOn').checked) return;
    try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (e) { /* none */ }
    try {
      const ac = S.audio; if (!ac) return;
      if (ac.state === 'suspended') ac.resume();
      [0, 0.32].forEach((off) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 880; o.type = 'square';
        g.gain.setValueAtTime(0.0001, ac.currentTime + off);
        g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + off + 0.24);
        o.connect(g).connect(ac.destination); o.start(ac.currentTime + off); o.stop(ac.currentTime + off + 0.26);
      });
    } catch (e) { /* no audio */ }
  }

  function startTracking() {
    if (!navigator.geolocation) { areaStatus('This browser can\'t share your location.', true); return; }
    try { S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)(); S.audio.resume(); } catch (e) { S.audio = null; }
    S.offCount = 0; S.off = false;
    clearHike();
    const grp = S.selected != null ? S.model.groups[S.selected] : null;
    S.hike = { t0: Date.now(), pts: [], dist: 0, maxOff: 0, offFixes: 0, fixes: 0, name: grp ? (grp.key === '__unnamed' ? 'Paths without a trail name' : grp.name) : (S.area.name || 'Trail') };
    S.watchId = navigator.geolocation.watchPosition(onFix, onFixErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
    const b = $('#trackBtn'); b.textContent = 'End trail'; b.classList.add('on');
    $('#gpsChip').hidden = false; $('#gpsChip').textContent = 'Finding your position...'; $('#gpsChip').className = 'gps-chip';
    $('#hikeStats').hidden = false; $('#walkGpx').hidden = true;
    S.hikeTimer = setInterval(updateHikeStats, 15000); updateHikeStats();
    $('#sheet').dataset.open = 'false';
    setFollow(true);
    wakeLock();
  }

  const fmtDur = (ms) => { const mn = Math.round(ms / 60000); return mn < 60 ? mn + ' min' : Math.floor(mn / 60) + ' h ' + (mn % 60) + ' min'; };
  function updateHikeStats() {
    const h = S.hike; if (!h) return;
    $('#hikeText').textContent = `On ${h.name} · ${fmtDur(Date.now() - h.t0)} · ${fmtMi(h.dist)} walked`;
  }

  function clearHike() {
    if (S.trackLine) { S.trackLine.remove(); S.trackLine = null; }
    S.hike = null; clearInterval(S.hikeTimer);
    const hs = $('#hikeStats'); if (hs) hs.hidden = true;
  }

  // silent: leaving the map, so no summary.
  function stopTracking(silent) {
    const wasOn = S.watchId != null;
    if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
    if (S.wake) { S.wake.release().catch(() => {}); S.wake = null; }
    clearInterval(S.hikeTimer);
    const b = $('#trackBtn'); b.classList.remove('on');
    b.textContent = S.selected != null && S.model ? 'Start this trail' : 'Start trail';
    $('#gpsChip').hidden = true; $('#alert').hidden = true;
    S.off = false; S.offCount = 0; S.me = null;
    if (S.meMarker) { S.meMarker.remove(); S.meMarker = null; }
    if (S.accCircle) { S.accCircle.remove(); S.accCircle = null; }
    if (S.offLine) { S.offLine.remove(); S.offLine = null; }
    setFollow(false);
    if (wasOn && !silent && S.hike) {
      const h = S.hike;
      h.t1 = Date.now();
      let txt = `Trail ended: ${h.name}. ${fmtDur(h.t1 - h.t0)}, ${fmtMi(h.dist)} walked.`;
      if (h.fixes) txt += h.maxOff <= 15 ? ' You stayed on the path the whole way.' : ` The furthest you got from the path was ${fmtOff(h.maxOff)}.`;
      else txt += ' Your phone never got a clear GPS fix, so nothing was recorded.';
      $('#hikeText').textContent = txt;
      $('#hikeStats').hidden = false;
      $('#walkGpx').hidden = h.pts.length < 2;
      $('#sheet').dataset.open = 'true';
    }
  }

  function onFixErr(e) {
    const chip = $('#gpsChip'); chip.hidden = false; chip.className = 'gps-chip bad';
    chip.textContent = e.code === 1 ? 'Location is off for this app' : 'Looking for GPS signal...';
    if (e.code === 1) { areaStatus(locError(e), true); stopTracking(); }
  }

  function targetIdx() {
    const m = S.model, v = $('#warnTarget').value;
    if (v === 'all') return null;
    const g = m.groups.find((x) => x.key === v);
    return g ? g.segIdx : null;
  }

  function onFix(pos) {
    const m = S.model; if (!m) return;
    const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
    S.me = L.latLng(lat, lon); S.lastFix = pos;
    if (!S.meMarker) {
      S.accCircle = L.circle(S.me, { radius: acc, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(S.map);
      S.meMarker = L.marker(S.me, { icon: L.divIcon({ className: 'mk-me', iconSize: [18, 18] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(S.map);
    } else { S.meMarker.setLatLng(S.me); S.accCircle.setLatLng(S.me).setRadius(acc); }
    if (S.follow) S.map.setView(S.me, Math.max(S.map.getZoom(), 17), { animate: false });

    const px = m.proj.x(lon), py = m.proj.y(lat);
    const near = nearestOnSegs(px, py, m.segs, targetIdx());
    const nll = L.latLng(m.proj.lat(near.y), m.proj.lon(near.x));
    const thr = +$('#warnDist').value;
    const chip = $('#gpsChip');
    const far = near.d > 3000;

    if (far) {
      chip.className = 'gps-chip'; chip.textContent = `You're ${fmtMi(near.d)} from these trails`;
      $('#alert').hidden = true; if (S.offLine) { S.offLine.remove(); S.offLine = null; }
      S.off = false; S.offCount = 0; return;
    }
    if (acc > 50) {
      chip.className = 'gps-chip bad'; chip.textContent = `Weak GPS (±${Math.round(acc)} m), warnings paused`;
      return;
    }
    recordFix(lat, lon, near.d);
    if (near.d > thr) S.offCount++; else if (near.d <= thr * 0.75) S.offCount = 0;

    if (!S.off && S.offCount >= 2) { S.off = true; S.lastAlert = 0; }
    if (S.off && near.d <= thr * 0.75) { S.off = false; showBackOn(); }

    if (S.off) {
      const dir = bearingName(lat, lon, nll.lat, nll.lng);
      chip.className = 'gps-chip bad'; chip.textContent = `Off trail · ${fmtOff(near.d)}`;
      $('#alertTitle').textContent = 'Off trail';
      $('#alertText').textContent = `The nearest path is ${fmtOff(near.d)} to the ${dir}. Follow the red dashed line.`;
      const a = $('#alert'); a.classList.remove('back'); a.hidden = false;
      if (!S.offLine) S.offLine = L.polyline([S.me, nll], { color: COLORS().danger, weight: 4, dashArray: '8 8', interactive: false }).addTo(S.map);
      else S.offLine.setLatLngs([S.me, nll]);
      if (Date.now() - S.lastAlert > 45000) { S.lastAlert = Date.now(); beep(); }
    } else if (near.d > thr) {
      chip.className = 'gps-chip'; chip.textContent = `Checking · ${fmtOff(near.d)} from path · GPS ±${Math.round(acc)} m`;
    } else {
      chip.className = 'gps-chip ok'; chip.textContent = `On trail · ${fmtOff(near.d)} from path · GPS ±${Math.round(acc)} m`;
      if (S.offLine) { S.offLine.remove(); S.offLine = null; }
    }
  }

  function recordFix(lat, lon, off) {
    const h = S.hike; if (!h) return;
    h.fixes++;
    if (off > h.maxOff) h.maxOff = off;
    const last = h.pts[h.pts.length - 1];
    const d = last ? hav(last[0], last[1], lat, lon) : Infinity;
    if (d < 5) return;
    if (last) h.dist += d;
    h.pts.push([lat, lon, Date.now()]);
    if (!S.trackLine) S.trackLine = L.polyline([], { color: COLORS().route, weight: 3, opacity: 0.8, dashArray: '1 6', lineCap: 'round', interactive: false }).addTo(S.map);
    S.trackLine.addLatLng([lat, lon]);
    updateHikeStats();
  }

  function walkGpx() {
    const h = S.hike; if (!h || h.pts.length < 2) return;
    const x = (v) => escapeHtml(String(v));
    const doc = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Trail Mapper" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${x(h.name)} walk</name><trkseg>${h.pts.map((p) => `<trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`).join('')}</trkseg></trk>\n</gpx>`;
    download(doc, (h.name || 'walk').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '-walk.gpx');
  }

  function download(text, name) {
    const blob = new Blob([text], { type: 'application/gpx+xml' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  let backTimer = null;
  function showBackOn() {
    const a = $('#alert'); a.classList.add('back'); a.hidden = false;
    $('#alertTitle').textContent = 'Back on trail'; $('#alertText').textContent = 'You\'re back near the path.';
    clearTimeout(backTimer); backTimer = setTimeout(() => { if (!S.off) a.hidden = true; }, 4000);
  }

  /* ---------------- way back to parking ---------------- */
  function clearRoute() { if (S.routeLayer) { S.routeLayer.remove(); S.routeLayer = null; } }

  function routeHome() {
    const m = S.model; if (!m) return;
    clearRoute();
    let from = S.me;
    if (!from) { areaStatus('Tap Start trail first so the app knows where you are.', true); return; }
    const targets = m.parking.length ? m.parking : m.pois.filter((p) => p.kind === 'trailhead');
    if (!targets.length) { areaStatus('No parking or trailhead is mapped here.', true); return; }
    const px = m.proj.x(from.lng), py = m.proj.y(from.lat);
    const near = nearestOnSegs(px, py, m.segs);
    const N = m.coords.length, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
    // the segment's two end nodes
    const so = near.i * 4, sx1 = m.segs[so], sy1 = m.segs[so + 1], sx2 = m.segs[so + 2], sy2 = m.segs[so + 3];
    const segLen = Math.hypot(sx2 - sx1, sy2 - sy1);
    const endA = closestNode(m, m.proj.lat(sy1), m.proj.lon(sx1)), endB = closestNode(m, m.proj.lat(sy2), m.proj.lon(sx2));
    const h = new Heap();
    dist[endA] = near.t * segLen; h.push(dist[endA], endA);
    if (endB !== endA) { dist[endB] = Math.min(dist[endB], (1 - near.t) * segLen); h.push(dist[endB], endB); }
    while (h.size) {
      const u = h.pop(), du = dist[u], nb = m.adj[u]; if (!nb) continue;
      for (let k = 0; k < nb.length; k += 2) { const v = nb[k], nd = du + nb[k + 1]; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; h.push(nd, v); } }
    }
    let best = null;
    for (const p of targets) {
      const ni = closestNode(m, p.lat, p.lon), c = m.coords[ni];
      const tot = dist[ni] + hav(c[0], c[1], p.lat, p.lon);
      if (isFinite(tot) && (!best || tot < best.tot)) best = { tot, ni, p };
    }
    const nll = L.latLng(m.proj.lat(near.y), m.proj.lon(near.x));
    if (!best) {
      const p = targets[0];
      S.routeLayer = L.polyline([from, [p.lat, p.lon]], { color: COLORS().route, weight: 5, dashArray: '4 10' }).addTo(S.map);
      areaStatus('The mapped paths don\'t connect to the parking, so this line is a straight direction only. Follow the park\'s signs.', true);
      return;
    }
    const path = []; for (let i = best.ni; i !== -1; i = prev[i]) path.push(m.coords[i]);
    path.reverse();
    const line = [from, nll, ...path, [best.p.lat, best.p.lon]];
    S.routeLayer = L.layerGroup([
      L.polyline(line, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false }),
      L.polyline(line, { color: COLORS().route, weight: 5, interactive: false }),
    ]).addTo(S.map);
    S.map.fitBounds(L.latLngBounds(line), { padding: [50, 50], maxZoom: 18 });
    setFollow(false);
    areaStatus(`Way back to ${best.p.name || 'parking'}: about ${fmtMi(best.tot + near.d)} along the paths (blue line).`);
    $('#sheet').dataset.open = 'true';
  }

  function closestNode(m, lat, lon) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < m.coords.length; i++) {
      if (!m.adj[i]) continue;
      const c = m.coords[i], d = (c[0] - lat) ** 2 + ((c[1] - lon) * 0.9) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  /* ---------------- GPX export ---------------- */
  function gpx() {
    const m = S.model; if (!m) return;
    const x = (s) => escapeHtml(String(s));
    const grp = S.selected != null ? m.groups[S.selected] : null;
    const wl = grp ? grp.ways.map((wi) => m.ways[wi]) : m.ways;
    const trk = wl.map((w) => `<trk><name>${x(w.tags.name || 'Path')}</name><desc>${x(w.surf)}</desc><trkseg>${w.ll.map((p) => `<trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}"/>`).join('')}</trkseg></trk>`).join('\n');
    const wpt = m.pois.filter((p) => p.kind === 'parking' || p.kind === 'trailhead').map((p) => `<wpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><name>${x(p.name || (p.kind === 'parking' ? 'Parking' : 'Trailhead'))}</name></wpt>`).join('\n');
    const doc = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Trail Mapper" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${x(grp ? grp.name + ', ' + m.area.name : m.area.name)}</name><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/</license></copyright></metadata>\n${wpt}\n${trk}\n</gpx>`;
    download(doc, ((grp ? grp.name + ' ' : '') + (m.area.name || 'trails')).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.gpx');
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---------------- routing by hash ---------------- */
  function route() {
    const mt = /^#\/area\/(way|relation)\/(\d+)(?:\/t\/(.+))?$/.exec(location.hash);
    if (mt) {
      const type = mt[1], id = +mt[2];
      let tk = null; try { tk = mt[3] ? decodeURIComponent(mt[3]) : null; } catch (e) { tk = null; }
      if (S.area && S.area.type === type && S.area.id === id) {
        if (S.model) { const gi = findGroup(S.model, tk); if (gi !== (S.selected == null ? -1 : S.selected)) highlightGroup(gi >= 0 ? gi : null, { noHash: true }); }
        return;
      }
      const known = [...S.list, ...store.get('saved', [])].find((a) => a.type === type && a.id === id) || store.get('last', null);
      const a = known && known.type === type && known.id === id ? known : { type, id, name: '', lat: 0, lon: 0, kind: 'nature' };
      openArea(a, true, tk);
    } else if (!$('#viewArea').hidden) backToFind();
  }

  /* ---------------- wire up ---------------- */
  function init() {
    setRadius(S.radius);
    setMode(S.mode);
    document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
      setRadius(+c.dataset.r);
      if (S.center) discover(S.center.lat, S.center.lon, S.center.label);
    }));
    $('#nearMe').addEventListener('click', nearMe);
    $('#searchForm').addEventListener('submit', onSearch);
    ['#surfFilter', '#sortBy', '#favOnly'].forEach((s) => $(s).addEventListener('change', renderList));
    $('#backBtn').addEventListener('click', () => { if (history.state === null && location.hash) history.back(); else { history.pushState(null, '', location.pathname); backToFind(); } });
    $('#favBtn').addEventListener('click', () => {
      const k = areaKey(S.area); if (S.favs[k]) delete S.favs[k]; else S.favs[k] = 1;
      store.set('favs', S.favs); setFav();
    });
    $('#followBtn').addEventListener('click', () => { if (!S.me) { areaStatus('Tap Start trail to see your position.'); return; } setFollow(!S.follow); });
    $('#fitBtn').addEventListener('click', () => { if (S.model) S.map.fitBounds(S.model.bounds, { padding: [30, 30] }); setFollow(false); });
    $('#trackBtn').addEventListener('click', () => (S.watchId == null ? startTracking() : stopTracking(false)));
    $('#walkGpx').addEventListener('click', walkGpx);
    $('#allTrailsBtn').addEventListener('click', () => highlightGroup(null));
    document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); renderList(); if (S.center) findStatus(listSummary(S.radius, S.center.label)); }));
    $('#homeBtn').addEventListener('click', routeHome);
    $('#alertRoute').addEventListener('click', () => { if (S.me && S.offLine) { S.map.fitBounds(S.offLine.getBounds(), { padding: [60, 60], maxZoom: 19 }); setFollow(false); } });
    $('#sheetHandle').addEventListener('click', () => { const s = $('#sheet'); s.dataset.open = s.dataset.open === 'true' ? 'false' : 'true'; });
    $('#warnTarget').addEventListener('change', () => { if (S.area) store.set('warn:' + areaKey(S.area), $('#warnTarget').value); S.offCount = 0; });
    $('#gpxBtn').addEventListener('click', gpx);
    $('#refreshBtn').addEventListener('click', async () => {
      if (!S.area) return;
      const keep = S.selected != null && S.model ? S.model.groups[S.selected].key : null;
      try { const m = await loadArea(S.area, true); if (m) { S.model = m; drawModel(m); renderSheet(m); rememberSaved(S.area, m); S.selected = null; const gi = findGroup(m, keep); highlightGroup(gi >= 0 ? gi : null, { noFit: gi < 0 }); } else areaStatus('No trails are mapped here on OpenStreetMap.', true); }
      catch (e) { areaStatus('Couldn\'t refresh. Check your signal.', true); }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeLock(); });
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);

    const c = store.get('center', null);
    if (c) { S.center = c; discover(c.lat, c.lon, c.label); }
    else findStatus('Tap Trails near me, or search a park, city or zip.');
    renderSaved();
    route();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // expose pure helpers for testing in Node
  if (typeof window.__TM_TEST__ !== 'undefined') window.__TM_TEST__ = { parseDiscovery, trailRows, groupShape, buildModel, nearestOnSegs, makeProj, hav, surfClass, surfWord, Heap, bearingName, fmtMi, discoveryQuery, areaQuery };
  else document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading' && typeof window.__TM_TEST__ === 'undefined') init();
})();
