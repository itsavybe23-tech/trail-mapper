/* Trail Mapper: South Florida state and county park trails from Florida's official trail
   inventory (FDEP Office of Greenways & Trails, "Existing Trails"). Shows each trail's map,
   tracks the hiker's live position, warns when they leave the path and routes them back
   along the trails. No server of its own: trail data comes straight from the state's map
   service and is kept on the phone. Parking and restrooms come from OpenStreetMap when
   that service answers. */
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
  const SF_VIEWBOX = '-82.95,28.0,-79.75,24.35';
  const SF_COUNTIES = ['Miami-Dade', 'Broward', 'Palm Beach', 'Monroe', 'Collier', 'Lee', 'Martin', 'St. Lucie', 'Hendry', 'Glades', 'Charlotte', 'Okeechobee'];
  const TRAILS_URLS = [
    'https://ca.dep.state.fl.us/arcgis/rest/services/OpenData/OGT/MapServer/3/query',
    'https://ags.dep.state.fl.us/arcgis/rest/services/OpenData/OGT/MapServer/3/query',
  ];
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const FIELDS = 'OBJECTID,SEGMENT_NAME,TRAIL_NAME,SURFACE,TYPE,MANAGING_AGENCY,MANAGING_SITE,COUNTY,GIS_MILES,LAST_UPDATE,URL';
  const STATE_SQL = "(MANAGING_AGENCY LIKE 'FDEP%' OR MANAGING_AGENCY LIKE 'Florida Fish%' OR MANAGING_AGENCY LIKE 'Florida Forest%' OR MANAGING_AGENCY LIKE '%Water Management District')";
  const COUNTY_SQL = "(MANAGING_AGENCY LIKE '%County%')";
  const FOOT_SQL = "(TYPE IS NULL OR (TYPE NOT LIKE 'Motorized%' AND TYPE <> 'Paddling'))";
  const DAY = 864e5;
  const DATA_V = 'v3';
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

  /* ---------------- storage ---------------- */
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
  async function getJson(url, timeoutMs, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 30000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  // Query Florida's trail inventory, page by page; tries the state's second server if the first fails.
  async function trailQuery(params, onPage) {
    const base = Object.assign({ outFields: FIELDS, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'json', orderByFields: 'OBJECTID' }, params);
    let lastErr;
    for (const url of TRAILS_URLS) {
      try {
        const feats = [];
        for (let offset = 0; offset < 20000; offset += 1000) {
          const body = new URLSearchParams(Object.assign({}, base, { resultOffset: String(offset), resultRecordCount: '1000' })).toString();
          const j = await getJson(url, 45000, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          if (j.error) throw new Error(j.error.message || 'service error');
          feats.push(...(j.features || []));
          if (onPage) onPage(feats.length);
          if (!j.exceededTransferLimit) break;
        }
        return feats;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('trail service out of reach');
  }

  async function geocode(q) {
    const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&bounded=1&viewbox=' + SF_VIEWBOX + '&q=' + encodeURIComponent(q);
    return getJson(u, 20000, { headers: { 'Accept-Language': 'en' } });
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
  const clean = (s) => String(s == null ? '' : s).trim();
  const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function surfClass(s) {
    s = clean(s).toLowerCase();
    if (/boardwalk|wood/.test(s)) return 'board';
    if (/unpaved|soft|natural|dirt|sand|grass|shell|gravel|lime/.test(s)) return 'nat';
    if (/paved|hard|asphalt|concrete/.test(s)) return 'paved';
    return 'unk';
  }
  const SURF_WORD = { board: 'boardwalk', paved: 'paved', nat: 'natural ground', unk: 'surface not listed' };
  function difficulty(st) {
    const tot = st.total || 1, easy = (st.board + st.paved) / tot;
    if (easy > 0.8) return 'Easy';
    if (st.total > 8000 && st.nat / tot > 0.5) return 'Moderate';
    return 'Easy to moderate';
  }
  function agencyKind(a) { return /county/i.test(a || '') ? 'county' : 'state'; }
  function agencyLabel(a) {
    a = clean(a);
    if (/^FDEP/i.test(a)) return 'Florida State Parks';
    if (/Fish and Wildlife/i.test(a)) return 'Florida Fish and Wildlife (state)';
    if (/Forest Service/i.test(a)) return 'Florida Forest Service (state)';
    if (/Water Management/i.test(a)) return a + ' (state)';
    return a;
  }
  const sql = (s) => String(s).replace(/'/g, "''");

  /* ---------------- state ---------------- */
  const S = {
    center: null, radius: store.get('radius', 24140), parks: [], favs: store.get('favs', {}),
    mode: store.get('mode', 'trails') === 'parks' ? 'parks' : 'trails',
    park: null, model: null, map: null, layers: null, halo: null, poiLayer: null, selected: null,
    watchId: null, me: null, follow: false, offCount: 0, off: false, lastAlert: 0, wake: null, audio: null,
    routeLayer: null, offLine: null, meMarker: null, accCircle: null, extras: null,
    hike: null, hikeTimer: null, trackLine: null,
  };

  /* ================= TRAIL DATA ================= */
  function slim(f) {
    const a = f.attributes || {}, g = f.geometry || {};
    return {
      id: a.OBJECTID, name: clean(a.SEGMENT_NAME) || clean(a.TRAIL_NAME), surf: clean(a.SURFACE), use: clean(a.TYPE),
      agency: clean(a.MANAGING_AGENCY), site: clean(a.MANAGING_SITE), county: clean(a.COUNTY), mi: +a.GIS_MILES || 0,
      upd: a.LAST_UPDATE || 0, url: clean(a.URL), paths: (g.paths || []).map((p) => p.map((c) => [+(+c[1]).toFixed(6), +(+c[0]).toFixed(6)])),
    };
  }
  const siteKey = (f) => f.site || (f.agency + ' · ' + f.county);
  const siteName = (f) => f.site || agencyLabel(f.agency) + ' trails, ' + f.county + ' County';

  // Group trail pieces into parks, and each park's pieces into named trails.
  function buildParks(feats) {
    const parks = new Map();
    for (const f of feats) {
      const k = siteKey(f);
      let p = parks.get(k);
      if (!p) { p = { key: k, name: siteName(f), agency: f.agency, kind: agencyKind(f.agency), county: f.county, mi: 0, easyMi: 0, la: 0, lo: 0, n: 0, trails: new Map(), bb: [90, 180, -90, -180] }; parks.set(k, p); }
      const sc = surfClass(f.surf);
      p.mi += f.mi; if (sc === 'board' || sc === 'paved') p.easyMi += f.mi;
      const tk = f.name || '__unnamed';
      let t = p.trails.get(tk);
      if (!t) { t = { name: tk, mi: 0, surf: {}, use: new Set(), la: 0, lo: 0, n: 0 }; p.trails.set(tk, t); }
      t.mi += f.mi; t.surf[sc] = (t.surf[sc] || 0) + f.mi; if (f.use) t.use.add(f.use);
      for (const path of f.paths) for (const c of path) {
        p.la += c[0]; p.lo += c[1]; p.n++; t.la += c[0]; t.lo += c[1]; t.n++;
        if (c[0] < p.bb[0]) p.bb[0] = c[0]; if (c[1] < p.bb[1]) p.bb[1] = c[1]; if (c[0] > p.bb[2]) p.bb[2] = c[0]; if (c[1] > p.bb[3]) p.bb[3] = c[1];
      }
    }
    const out = [];
    for (const p of parks.values()) {
      if (!p.n) continue;
      p.lat = p.la / p.n; p.lon = p.lo / p.n;
      p.trailList = [...p.trails.values()].filter((t) => t.n).map((t) => {
        const tot = t.mi || 1, easy = ((t.surf.board || 0) + (t.surf.paved || 0)) / tot, nat = (t.surf.nat || 0) / tot;
        return { name: t.name, mi: t.mi, lat: t.la / t.n, lon: t.lo / t.n, cls: easy + nat < 0.5 ? 'unk' : easy >= nat ? 'easy' : 'nat', use: [...t.use].join(', ') };
      });
      delete p.trails; delete p.la; delete p.lo; delete p.n;
      out.push(p);
    }
    return out;
  }

  /* ================= FIND VIEW ================= */
  const findStatus = (msg, err) => { const s = $('#findStatus'); s.textContent = msg || ''; s.classList.toggle('err', !!err); };
  const errWord = (e) => (e && e.name === 'AbortError' ? 'it timed out' : (e && e.message) || 'no answer');

  function agencySql() {
    const who = ($('#whoFilter') || {}).value || 'both';
    return who === 'state' ? STATE_SQL : who === 'county' ? COUNTY_SQL : `(${STATE_SQL} OR ${COUNTY_SQL})`;
  }

  async function discover(lat, lon, label) {
    const all = S.radius === 0;
    if (!all) { S.center = { lat, lon, label }; store.set('center', S.center); }
    const where = `${agencySql()} AND ${FOOT_SQL} AND COUNTY IN (${SF_COUNTIES.map((c) => `'${sql(c)}'`).join(',')})`;
    const key = `disc:${DATA_V}:${all ? 'all' : lat.toFixed(2) + ',' + lon.toFixed(2) + ',' + S.radius}:${($('#whoFilter') || {}).value || 'both'}`;
    const where2 = all ? 'all of South Florida' : `${fmtMi(S.radius)} of ${label}`;
    $('#areaList').replaceChildren();
    const hit = await cacheGet(key, 7 * DAY);
    if (hit) { S.parks = hit.data; renderList(); findStatus(listSummary(where2) + ` Saved list from ${new Date(hit.time).toLocaleDateString()}.`); return; }
    findStatus(`Loading state and county trails within ${where2}...`);
    try {
      const params = { where, maxAllowableOffset: '0.0005' };
      if (!all) Object.assign(params, { geometry: `${lon.toFixed(5)},${lat.toFixed(5)}`, geometryType: 'esriGeometryPoint', inSR: '4326', distance: String(S.radius), units: 'esriSRUnit_Meter', spatialRel: 'esriSpatialRelIntersects' });
      const feats = await trailQuery(params, (n) => findStatus(`Loading state and county trails within ${where2}... ${n} trail pieces so far.`));
      S.parks = buildParks(feats.map(slim));
      await cachePut(key, S.parks);
      renderList();
      findStatus(S.parks.length ? listSummary(where2) : `No state or county trails found within ${where2}. Try a bigger radius.`);
    } catch (e) {
      findStatus(`Florida's trail service didn't answer (${errWord(e)}). Check your signal and try again.`, true);
    }
  }

  function trailRows() {
    const rows = [];
    for (const p of S.parks) for (const t of p.trailList) rows.push({ park: p, name: t.name, mi: t.mi, lat: t.lat, lon: t.lon, cls: t.cls, use: t.use });
    return rows;
  }
  const listSummary = (where2) => `${trailRows().length} trails in ${S.parks.length} state and county parks within ${where2}.`;

  function surfTag(cls) {
    if (cls === 'easy') return el('span', { class: 'tag' }, [el('i', { style: 'background:var(--board)' }), 'Boardwalk or paved']);
    if (cls === 'nat') return el('span', { class: 'tag' }, [el('i', { style: 'background:var(--nat)' }), 'Natural ground']);
    return el('span', { class: 'tag' }, [el('i', { style: 'background:var(--unk)' }), 'Surface not listed']);
  }
  const kindTag = (p) => el('span', { class: 'tag', text: p.kind === 'county' ? 'County' : 'State' });
  const favTag = (k) => (S.favs[k] ? el('span', { class: 'tag' }, [el('span', { class: 'fav', text: '★' }), 'Favorite']) : null);

  function parkCard(p) {
    const d = S.center && S.radius ? hav(S.center.lat, S.center.lon, p.lat, p.lon) : null;
    const nT = p.trailList.filter((t) => t.name !== '__unnamed').length;
    return el('li', null, [el('button', { class: 'area', type: 'button', onclick: () => openPark(p.key) }, [
      el('h3', { text: p.name }),
      d != null ? el('span', { class: 'dist', text: fmtMi(d) }) : null,
      el('div', { class: 'meta' }, [
        kindTag(p),
        el('span', { class: 'tag', text: `${nT} trail${nT === 1 ? '' : 's'} · ${fmtMi(p.mi * 1609.344)}` }),
        surfTag(p.mi && p.easyMi / p.mi > 0.5 ? 'easy' : 'nat'),
        favTag(p.key),
      ]),
    ])]);
  }

  function trailCard(r) {
    const d = S.center && S.radius ? hav(S.center.lat, S.center.lon, r.lat, r.lon) : null;
    return el('li', null, [el('button', { class: 'area trail', type: 'button', onclick: () => openPark(r.park.key, r.name) }, [
      el('h3', { text: r.name === '__unnamed' ? 'Unnamed trail at ' + r.park.name : r.name }),
      d != null ? el('span', { class: 'dist', text: fmtMi(d) }) : null,
      el('div', { class: 'meta' }, [
        el('span', { class: 'tag park', text: r.park.name }),
        kindTag(r.park),
        el('span', { class: 'tag', text: fmtMi(r.mi * 1609.344) }),
        surfTag(r.cls),
        r.use ? el('span', { class: 'tag', text: r.use }) : null,
        favTag(r.park.key),
      ]),
    ])]);
  }

  function setMode(mode) {
    S.mode = mode; store.set('mode', mode);
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  }

  function renderList() {
    const surf = $('#surfFilter').value, sort = $('#sortBy').value, favOnly = $('#favOnly').checked;
    const c = S.center && S.radius ? S.center : null, dist = (x) => (c ? hav(c.lat, c.lon, x.lat, x.lon) : 0);
    const byName = sort === 'name' || (sort === 'dist' && !c);
    if (S.mode === 'parks') {
      let L = S.parks.slice();
      if (surf === 'easy') L = L.filter((p) => p.mi && p.easyMi / p.mi > 0.5);
      if (surf === 'natural') L = L.filter((p) => p.mi && p.easyMi / p.mi <= 0.5);
      if (favOnly) L = L.filter((p) => S.favs[p.key]);
      if (sort === 'dist' && c) L.sort((x, y) => dist(x) - dist(y));
      if (sort === 'len') L.sort((x, y) => y.mi - x.mi);
      if (byName) L.sort((x, y) => x.name.localeCompare(y.name));
      $('#areaList').replaceChildren(...L.map(parkCard));
    } else {
      let T = trailRows();
      if (surf === 'easy') T = T.filter((t) => t.cls === 'easy');
      if (surf === 'natural') T = T.filter((t) => t.cls === 'nat');
      if (favOnly) T = T.filter((t) => S.favs[t.park.key]);
      const nm = (t) => (t.name === '__unnamed' ? '~' : t.name);
      if (sort === 'dist' && c) T.sort((x, y) => dist(x) - dist(y));
      if (sort === 'len') T.sort((x, y) => y.mi - x.mi);
      if (byName) T.sort((x, y) => nm(x).localeCompare(nm(y)) || x.park.name.localeCompare(y.park.name));
      $('#areaList').replaceChildren(...T.slice(0, 600).map(trailCard));
    }
    renderSaved();
  }

  function renderSaved() {
    const saved = store.get('saved2', []);
    $('#savedBlock').hidden = !saved.length;
    $('#savedList').replaceChildren(...saved.map((s) => el('li', null, [el('button', { class: 'area', type: 'button', onclick: () => openPark(s.key) }, [
      el('h3', { text: s.name }),
      el('div', { class: 'meta' }, [el('span', { class: 'tag', text: s.kind === 'county' ? 'County' : 'State' }), el('span', { class: 'tag', text: fmtMi(s.m) + ' of trails' })]),
    ])])));
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
    if (e && e.code === 1) return 'Location is turned off for this app. Allow location in your browser settings, or pick All South Florida, or search a place.';
    if (e && e.code === 3) return 'Your phone took too long to find you. Step outside or try again.';
    return 'Your location isn\'t available right now. Pick All South Florida or search a place instead.';
  }

  async function nearMe() {
    if (S.radius === 0) setRadius(24140);
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
    const s = sql(q.slice(0, 60)).toUpperCase();
    const [parksR, placesR] = await Promise.allSettled([
      trailQuery({ where: `${agencySql()} AND ${FOOT_SQL} AND (UPPER(MANAGING_SITE) LIKE '%${s}%' OR UPPER(SEGMENT_NAME) LIKE '%${s}%')`, returnGeometry: 'false', outFields: 'OBJECTID,MANAGING_SITE,MANAGING_AGENCY,COUNTY,SEGMENT_NAME' }),
      geocode(q),
    ]);
    const kids = [];
    if (parksR.status === 'fulfilled') {
      const seen = new Map(), nq = normName(q);
      for (const f of parksR.value) {
        const a = slim(f); if (!SF_COUNTIES.includes(a.county)) continue;
        const k = siteKey(a), hitName = a.name && normName(a.name).includes(nq) ? a.name : null;
        const prev = seen.get(k);
        if (!prev) seen.set(k, { k, name: siteName(a), county: a.county, agency: a.agency, trail: hitName });
        else if (!prev.trail && hitName) prev.trail = hitName;
      }
      for (const r of [...seen.values()].slice(0, 8)) {
        kids.push(el('button', { type: 'button', onclick: () => { box.hidden = true; openPark(r.k, r.trail || undefined); } }, [
          el('span', { text: r.trail ? `${r.trail}, ${r.name}` : r.name }), el('small', { text: `${agencyKind(r.agency) === 'county' ? r.agency : agencyLabel(r.agency) + ' · ' + r.county + ' County'} · open trail map` }),
        ]));
      }
    }
    if (placesR.status === 'fulfilled') {
      for (const r of placesR.value.slice(0, 5)) {
        const lat = +r.lat, lon = +r.lon, name = r.name || r.display_name.split(',')[0];
        kids.push(el('button', { type: 'button', onclick: () => { box.hidden = true; if (S.radius === 0) setRadius(24140); discover(lat, lon, name); } }, [
          el('span', { text: name }), el('small', { text: 'Find state and county trails near here · ' + r.display_name.split(',').slice(1, 3).join(',').trim() }),
        ]));
      }
    }
    const bothFailed = parksR.status === 'rejected' && placesR.status === 'rejected';
    if (!kids.length) kids.push(el('p', { class: 'status' + (bothFailed ? ' err' : ''), text: bothFailed ? 'Search is out of reach right now. Check your signal and try again.' : 'Nothing found in South Florida for that. Try a park name, trail name, city or zip.' }));
    box.replaceChildren(...kids);
  }

  /* ================= PARK VIEW ================= */
  const areaStatus = (msg, err) => { const s = $('#areaStatus'); s.textContent = msg || ''; s.classList.toggle('err', !!err); };

  async function loadPark(key, force) {
    const ck = `park:${DATA_V}:${key}`;
    if (!force) { const hit = await cacheGet(ck, 0); if (hit && hit.data.length) return { feats: hit.data, time: hit.time }; }
    let where;
    if (key.includes(' · ')) {
      const [ag, co] = key.split(' · ');
      where = `(MANAGING_SITE IS NULL OR MANAGING_SITE = ' ' OR MANAGING_SITE = '') AND MANAGING_AGENCY = '${sql(ag)}' AND COUNTY = '${sql(co)}'`;
    } else where = `MANAGING_SITE = '${sql(key)}'`;
    const feats = (await trailQuery({ where: `${where} AND ${FOOT_SQL}` })).map(slim).filter((f) => f.paths.length);
    if (feats.length) await cachePut(ck, feats);
    return { feats, time: Date.now() };
  }

  // Graph from the official lines. Points within about 1 m are one point. A trail end within
  // 8 m of another trail point is joined to it, because separately drawn pieces rarely meet exactly.
  function buildModel(key, feats) {
    const ways = [];
    feats.forEach((f) => f.paths.forEach((p) => { if (p.length > 1) ways.push({ f, ll: p }); }));
    if (!ways.length) return null;
    let la = 0, lo = 0, cnt = 0;
    for (const w of ways) for (const c of w.ll) { la += c[0]; lo += c[1]; cnt++; }
    const proj = makeProj(la / cnt, lo / cnt);
    const idx = new Map(), coords = [], adj = [];
    const nodeIndex = (c) => { const k = Math.round(proj.x(c[1])) + ',' + Math.round(proj.y(c[0])); let i = idx.get(k); if (i === undefined) { i = coords.length; idx.set(k, i); coords.push(c); } return i; };
    const link = (u, v, d) => { (adj[u] || (adj[u] = [])).push(v, d); (adj[v] || (adj[v] = [])).push(u, d); };
    const segList = [], segWay = [];
    const stats = { total: 0, board: 0, paved: 0, nat: 0, unk: 0 };
    const groups = new Map();
    ways.forEach((w, wi) => {
      w.cls = surfClass(w.f.surf); w.len = 0; w.ni = [];
      let prev = null;
      for (const c of w.ll) {
        const i = nodeIndex(c);
        if (prev !== null && prev !== i) {
          const q = coords[prev], d = hav(q[0], q[1], c[0], c[1]);
          link(prev, i, d);
          segList.push(proj.x(q[1]), proj.y(q[0]), proj.x(c[1]), proj.y(c[0])); segWay.push(wi);
          w.len += d;
        }
        if (prev !== i) w.ni.push(i);
        prev = i;
      }
      stats.total += w.len; stats[w.cls] += w.len;
      const gk = w.f.name || '__unnamed';
      let g = groups.get(gk);
      if (!g) { g = { key: gk, name: gk === '__unnamed' ? 'Unnamed trail' : gk, len: 0, cls: { board: 0, paved: 0, nat: 0, unk: 0, total: 0 }, ways: [], segs: [], use: new Set(), surfRaw: new Set(), upd: 0, miListed: 0, fids: new Set() }; groups.set(gk, g); }
      g.len += w.len; g.ways.push(wi); g.cls[w.cls] += w.len; g.cls.total += w.len;
      if (w.f.use) g.use.add(w.f.use);
      if (w.f.surf) g.surfRaw.add(w.f.surf);
      if (w.f.upd > g.upd) g.upd = w.f.upd;
      if (!g.fids.has(w.f.id)) { g.fids.add(w.f.id); g.miListed += w.f.mi; }
    });
    // join loose ends to nearby trail points
    const deg = (i) => (adj[i] ? adj[i].length / 2 : 0);
    const grid = new Map(), cell = 10;
    coords.forEach((c, i) => { const k = Math.floor(proj.x(c[1]) / cell) + ',' + Math.floor(proj.y(c[0]) / cell); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    coords.forEach((c, i) => {
      if (deg(i) !== 1) return;
      const x = proj.x(c[1]), y = proj.y(c[0]), gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      let best = -1, bd = 8;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get((gx + dx) + ',' + (gy + dy)) || []) {
        if (j === i) continue;
        const nb = adj[i] || []; let linked = false; for (let k = 0; k < nb.length; k += 2) if (nb[k] === j) linked = true;
        if (linked) continue;
        const d = Math.hypot(proj.x(coords[j][1]) - x, proj.y(coords[j][0]) - y);
        if (d < bd) { bd = d; best = j; }
      }
      if (best >= 0) link(i, best, bd);
    });
    const segs = new Float64Array(segList);
    segWay.forEach((wi, si) => groups.get(ways[wi].f.name || '__unnamed').segs.push(si));
    const groupList = [...groups.values()].sort((x, y) => (x.key === '__unnamed') - (y.key === '__unnamed') || y.len - x.len);
    for (const g of groupList) { g.segIdx = Int32Array.from(g.segs); Object.assign(g, groupShape(g, ways, adj)); }
    const f0 = feats[0];
    return {
      key, ways, coords, adj, segs, segWay, proj, stats, groups: groupList,
      info: { name: siteName(f0), agency: f0.agency, kind: agencyKind(f0.agency), county: f0.county, url: (feats.find((f) => /^https:\/\//.test(f.url)) || {}).url || '' },
      bounds: L.latLngBounds(ways.flatMap((w) => w.ll)),
    };
  }

  // Loop, one way, loop with a spur, or branches, and whether the pieces join up.
  // Worked out from the official lines only; short joins between a trail's own ends count.
  function groupShape(g, ways, adj) {
    const deg = new Map(), parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
    const edge = (u, v) => { add(u); add(v); deg.set(u, (deg.get(u) || 0) + 1); deg.set(v, (deg.get(v) || 0) + 1); const ru = find(u), rv = find(v); if (ru !== rv) parent.set(ru, rv); };
    const mine = new Set();
    for (const wi of g.ways) { const ni = ways[wi].ni; for (const n of ni) mine.add(n); for (let k = 1; k < ni.length; k++) edge(ni[k - 1], ni[k]); }
    if (adj) {
      const own = new Set(); for (const wi of g.ways) { const ni = ways[wi].ni; for (let k = 1; k < ni.length; k++) own.add(ni[k - 1] + ':' + ni[k]).add(ni[k] + ':' + ni[k - 1]); }
      for (const u of mine) { const nb = adj[u] || []; for (let k = 0; k < nb.length; k += 2) { const v = nb[k]; if (u < v && mine.has(v) && nb[k + 1] < 8 && !own.has(u + ':' + v)) edge(u, v); } }
    }
    const roots = new Set(); let odd = 0, maxDeg = 0;
    for (const [n, d] of deg) { roots.add(find(n)); if (d % 2) odd++; if (d > maxDeg) maxDeg = d; }
    const pieces = roots.size;
    let shape = 'network';
    if (pieces === 1 && odd === 0) shape = 'loop';
    else if (pieces === 1 && odd === 2 && maxDeg <= 2) shape = 'line';
    else if (pieces === 1 && odd === 2) shape = 'lollipop';
    return { pieces, shape };
  }

  function ensureMap() {
    if (S.map) return S.map;
    const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true, tap: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, crossOrigin: true,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · Trails: Florida DEP',
    }).addTo(map);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    map.on('dragstart', () => setFollow(false));
    map.setView([26.2, -80.6], 8);
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
      const line = L.polyline(w.ll, { renderer, color: C[w.cls], weight: w.cls === 'board' ? 6 : 5, opacity: 0.95, dashArray: w.cls === 'unk' ? '6 6' : null, lineCap: 'round' });
      line.bindPopup(() => `<b>${escapeHtml(w.f.name || 'Unnamed trail')}</b><br>${escapeHtml(SURF_WORD[w.cls])}${w.f.use ? ' · ' + escapeHtml(w.f.use) : ''}`);
      line.addTo(g);
    });
    S.layers = g; S.halo = halo; S.poiLayer = L.layerGroup().addTo(g);
    map.invalidateSize();
    map.fitBounds(m.bounds, { padding: [30, 30], maxZoom: 17 });
  }

  // Parking, restrooms and trailheads from OpenStreetMap. Optional: the trail map works without it.
  async function loadExtras(m) {
    const ck = `extras:${DATA_V}:${m.key}`;
    const hit = await cacheGet(ck, 30 * DAY);
    if (hit) return hit.data;
    const b = m.bounds.pad(0.05), bb = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(5)).join(',');
    const q = `[out:json][timeout:20];(nwr[amenity=parking][access!~"^(private|no)$"](${bb});node[highway=trailhead](${bb});nwr[amenity=toilets](${bb}););out center tags;`;
    let els = null;
    for (const ep of OVERPASS) {
      try { const j = await getJson(ep, 25000, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); els = j.elements || []; break; } catch (e) { /* next */ }
    }
    if (!els) return null;
    els = els.map((e) => { const c = e.type === 'node' ? e : e.center; const t = e.tags || {}; return c ? { kind: t.amenity === 'parking' ? 'parking' : t.amenity === 'toilets' ? 'toilets' : 'trailhead', lat: c.lat, lon: c.lon, name: t.name || '' } : null; })
      .filter((p) => p && nearestOnSegs(m.proj.x(p.lon), m.proj.y(p.lat), m.segs).d < 600);
    await cachePut(ck, els);
    return els;
  }

  function drawExtras() {
    if (!S.poiLayer) return;
    S.poiLayer.clearLayers();
    const C = COLORS();
    for (const p of S.extras || []) {
      if (p.kind === 'parking') L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'mk-p', html: 'P', iconSize: [20, 20] }), keyboard: false }).bindPopup(escapeHtml(p.name || 'Parking')).addTo(S.poiLayer);
      else L.circleMarker([p.lat, p.lon], { radius: 6, color: '#fff', weight: 2, fillColor: p.kind === 'toilets' ? '#6a4fb3' : C.sun, fillOpacity: 1 }).bindPopup(p.kind === 'toilets' ? 'Restrooms' : escapeHtml(p.name || 'Trailhead')).addTo(S.poiLayer);
    }
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
      L.polyline(grp.ways.map((wi) => m.ways[wi].ll), { color: C.sun, weight: 12, opacity: 0.55, interactive: false }).addTo(S.halo);
      if (!opts.noFit) S.map.fitBounds(groupBounds(m, grp), { padding: [40, 40], maxZoom: 17 });
      const sel = $('#warnTarget');
      if ([...sel.options].some((o) => o.value === grp.key)) sel.value = grp.key;
      S.offCount = 0;
    } else if (!opts.noFit) S.map.fitBounds(m.bounds, { padding: [30, 30], maxZoom: 17 });
    renderTrailDetail(m, grp);
    setDirections(m, grp);
    $('#areaName').textContent = grp && grp.key !== '__unnamed' ? grp.name : m.info.name;
    if (!opts.noHash) {
      const h = '#/park/' + encodeURIComponent(m.key) + (grp ? '/t/' + encodeURIComponent(grp.key) : '');
      if (location.hash !== h) history.replaceState(null, '', h);
    }
    $('#trackBtn').textContent = S.watchId != null ? 'End trail' : grp ? 'Start this trail' : 'Start trail';
  }

  const SHAPE = {
    loop: ['Loop', 'Ends where it starts'],
    line: ['One way', 'Walk back the same way, or arrange a ride'],
    lollipop: ['Loop with a spur', 'Walk the spur both ways'],
    network: ['Several branches', 'Pieces with this name branch or cross'],
  };

  function nearestPoi(m, grp, kinds) {
    let best = null, bd = Infinity;
    for (const p of S.extras || []) {
      if (!kinds.includes(p.kind)) continue;
      const r = nearestOnSegs(m.proj.x(p.lon), m.proj.y(p.lat), m.segs, grp ? grp.segIdx : null);
      if (r.d < bd) { bd = r.d; best = p; }
    }
    return best ? { p: best, d: bd } : null;
  }

  function surfLine(st) {
    const tot = st.total || 1, pct = (v) => Math.round((v / tot) * 100);
    return [['board', 'boardwalk'], ['paved', 'paved'], ['nat', 'natural ground'], ['unk', 'surface not listed']]
      .filter(([k]) => st[k] / tot >= 0.05).map(([k, w]) => `${pct(st[k])}% ${w}`).join(', ');
  }

  function renderTrailDetail(m, grp) {
    const box = $('#trailDetail');
    if (!grp) { box.hidden = true; $('#areaFactsHead').textContent = 'About this park'; return; }
    box.hidden = false;
    $('#areaFactsHead').textContent = 'About the park';
    $('#tdName').textContent = grp.name;
    $('#tdPark').textContent = `${m.info.name} · ${agencyLabel(m.info.agency)}`;
    const sh = SHAPE[grp.shape];
    const lenLabel = grp.shape === 'line' ? `One way · about ${fmtMi(grp.len * 2)} there and back` : grp.shape === 'loop' ? 'Around the loop' : 'All pieces with this name';
    const facts = [
      el('div', { class: 'fact' }, [el('b', { text: fmtMi(grp.len) }), el('span', { text: lenLabel })]),
      el('div', { class: 'fact' }, [el('b', { text: grp.pieces > 1 ? 'Not joined up' : sh[0] }), el('span', { text: grp.pieces > 1 ? `Drawn in ${grp.pieces} separate pieces` : sh[1] })]),
      el('div', { class: 'fact' }, [el('b', { text: difficulty(grp.cls) }), el('span', { text: 'Difficulty (estimate)' })]),
      el('div', { class: 'fact' }, [el('b', { text: [...grp.use].join(', ') || 'Not listed' }), el('span', { text: 'Allowed use' })]),
      el('div', { class: 'fact wide' }, [el('b', { text: [...grp.surfRaw].join(', ') || 'Not listed' }), el('span', { text: 'Surface' })]),
    ];
    const start = nearestPoi(m, grp, ['parking']) || nearestPoi(m, grp, ['trailhead']);
    if (start) facts.push(el('div', { class: 'fact wide' }, [el('b', { text: `${start.p.name || (start.p.kind === 'parking' ? 'Parking lot' : 'Trailhead')}, ${fmtMi(start.d)} from the trail` }), el('span', { text: start.p.kind === 'parking' ? 'Nearest parking (OpenStreetMap)' : 'Nearest trailhead (OpenStreetMap)' })]));
    if (S.extras) { const wc = nearestPoi(m, grp, ['toilets']); facts.push(el('div', { class: 'fact wide' }, [el('b', { text: wc && wc.d < 400 ? `${fmtMi(wc.d)} from the trail` : 'None mapped near this trail' }), el('span', { text: 'Restrooms (OpenStreetMap)' })])); }
    $('#tdFacts').replaceChildren(...facts);

    const notes = [];
    if (grp.pieces > 1) notes.push(`The state's map draws this trail in ${grp.pieces} pieces that don't join up. Follow the park's signs where there's a gap.`);
    if (grp.cls.unk / (grp.cls.total || 1) >= 0.2) notes.push('The surface isn\'t listed for part of this trail. Those parts show as a dashed line.');
    if (grp.miListed && grp.len && Math.abs(grp.miListed * 1609.344 - grp.len) / grp.len > 0.15) notes.push(`The state lists this trail as ${grp.miListed.toFixed(1)} mi, but the drawn line measures ${fmtMi(grp.len)}.`);
    if (grp.upd) notes.push(`From Florida's official trail inventory, last updated ${new Date(grp.upd).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}.`);
    notes.push('The line is drawn exactly as the state publishes it. Nothing is guessed or filled in.');
    $('#tdNotes').replaceChildren(...notes.map((n) => el('li', { text: n })));
  }

  function setDirections(m, grp) {
    const near = nearestPoi(m, grp, ['parking']) || nearestPoi(m, grp, ['trailhead']);
    const dir = $('#dirLink');
    if (near) { dir.href = `https://www.google.com/maps/dir/?api=1&destination=${near.p.lat.toFixed(6)},${near.p.lon.toFixed(6)}`; dir.textContent = near.p.kind === 'parking' ? 'Directions to parking' : 'Directions to trailhead'; }
    else { dir.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${m.info.name}, ${m.info.county} County, Florida`); dir.textContent = 'Directions to the park'; }
  }

  function renderSheet(m) {
    const st = m.stats;
    const nNamed = m.groups.filter((g) => g.key !== '__unnamed').length;
    const facts = [
      el('div', { class: 'fact' }, [el('b', { text: fmtMi(st.total) }), el('span', { text: 'Trails in all' })]),
      el('div', { class: 'fact' }, [el('b', { text: String(nNamed) }), el('span', { text: 'Named trails' })]),
      el('div', { class: 'fact wide' }, [el('b', { text: agencyLabel(m.info.agency) }), el('span', { text: `Run by · ${m.info.county} County` })]),
      el('div', { class: 'fact wide' }, [el('b', { text: surfLine(st) || 'Surface not listed' }), el('span', { text: 'Surface, all trails' })]),
    ];
    if (m.info.url) facts.push(el('div', { class: 'fact wide' }, [el('b', null, [el('a', { href: m.info.url, target: '_blank', rel: 'noopener', text: 'Official park page' })]), el('span', { text: 'Hours, fees, closures and rules' })]));
    $('#facts').replaceChildren(...facts);

    const C = COLORS();
    $('#trailList').replaceChildren(...m.groups.map((g, i) => {
      const w0 = m.ways[g.ways[0]];
      const shape = g.pieces > 1 ? 'not joined up' : SHAPE[g.shape][0].toLowerCase();
      return el('li', null, [el('button', { type: 'button', 'aria-pressed': 'false', onclick: () => { highlightGroup(S.selected === i ? null : i); $('.sheet-body').scrollTop = 0; } }, [
        el('i', { style: `background:${C[w0.cls]}` }),
        el('span', { class: 'nm' }, [g.name, el('small', { text: [[...g.use].join(', '), shape].filter(Boolean).join(' · ') })]),
        el('span', { class: 'ln', text: fmtMi(g.len) }),
      ])]);
    }));

    const sel = $('#warnTarget');
    sel.replaceChildren(el('option', { value: 'all', text: 'Any trail in this park' }), ...m.groups.map((g) => el('option', { value: g.key, text: g.name })));
    const saved = store.get('warn:' + m.key, 'all');
    if ([...sel.options].some((o) => o.value === saved)) sel.value = saved;
    setDirections(m, null);
    const age = Math.round((Date.now() - m.fetched) / DAY);
    areaStatus(`${nNamed} named trail${nNamed === 1 ? '' : 's'} here. Pick one below. Trail lines ${age < 1 ? 'downloaded today' : 'saved ' + age + ' day' + (age === 1 ? '' : 's') + ' ago'}.`);
  }

  function findGroup(m, key) {
    if (!key) return -1;
    let i = m.groups.findIndex((g) => g.key === key);
    if (i < 0) i = m.groups.findIndex((g) => normName(g.key) === normName(key));
    return i;
  }

  async function openPark(key, trailKey, fromHash, force) {
    stopTracking(true); clearHike();
    $('#viewFind').hidden = true; $('#viewArea').hidden = false;
    const known = S.parks.find((p) => p.key === key);
    $('#areaName').textContent = trailKey && trailKey !== '__unnamed' ? trailKey : (known ? known.name : key);
    S.park = key; S.model = null; S.extras = null; S.selected = null;
    setFav();
    if (!fromHash) { const h = '#/park/' + encodeURIComponent(key) + (trailKey ? '/t/' + encodeURIComponent(trailKey) : ''); if (location.hash !== h) history.pushState(null, '', h); }
    const map = ensureMap();
    setTimeout(() => map.invalidateSize(), 50);
    if (S.layers) { S.layers.remove(); S.layers = null; }
    clearRoute();
    $('#trailDetail').hidden = true; $('#facts').replaceChildren(); $('#trailList').replaceChildren(); $('#warnTarget').replaceChildren();
    if (known) map.fitBounds([[known.bb[0], known.bb[1]], [known.bb[2], known.bb[3]]]);
    areaStatus('Loading the trail lines...');
    try {
      const r = await loadPark(key, force);
      if (S.park !== key) return;
      const m = r.feats.length ? buildModel(key, r.feats) : null;
      if (!m) { areaStatus('No trail lines came back for this park. Try Refresh trail data.', true); return; }
      m.fetched = r.time;
      S.model = m;
      drawModel(m); renderSheet(m); rememberSaved(m);
      const gi = findGroup(m, trailKey);
      if (gi >= 0) highlightGroup(gi, { noHash: true });
      else {
        highlightGroup(null, { noFit: true, noHash: true });
        if (trailKey && trailKey !== '__unnamed') areaStatus(`"${trailKey}" isn't in this park's trail lines. Pick a trail below.`, true);
      }
      loadExtras(m).then((ex) => {
        if (S.model !== m || !ex) return;
        S.extras = ex; drawExtras();
        const grp = S.selected != null ? m.groups[S.selected] : null;
        if (grp) renderTrailDetail(m, grp);
        setDirections(m, grp);
      }).catch(() => {});
    } catch (e) {
      areaStatus(`Couldn't download the trail lines (${errWord(e)}). Check your signal and tap Refresh trail data.`, true);
    }
  }

  function rememberSaved(m) {
    const entry = { key: m.key, name: m.info.name, kind: m.info.kind, m: m.stats.total };
    const saved = store.get('saved2', []).filter((s) => s.key !== m.key);
    saved.unshift(entry);
    store.set('saved2', saved.slice(0, 25));
  }

  function setFav() {
    const on = !!(S.park && S.favs[S.park]);
    const b = $('#favBtn'); b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
  }

  function backToFind() {
    stopTracking(true); clearHike();
    $('#viewArea').hidden = true; $('#viewFind').hidden = false;
    S.park = null; S.model = null;
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
    if (!S.model) return;
    if (!navigator.geolocation) { areaStatus('This browser can\'t share your location.', true); return; }
    try { S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)(); S.audio.resume(); } catch (e) { S.audio = null; }
    S.offCount = 0; S.off = false;
    clearHike();
    const grp = S.selected != null ? S.model.groups[S.selected] : null;
    S.hike = { t0: Date.now(), pts: [], dist: 0, maxOff: 0, fixes: 0, start: null, name: grp ? grp.name : S.model.info.name };
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
  function updateHikeStats() { const h = S.hike; if (h && S.watchId != null) $('#hikeText').textContent = `On ${h.name} · ${fmtDur(Date.now() - h.t0)} · ${fmtMi(h.dist)} walked`; }

  function clearHike() {
    if (S.trackLine) { S.trackLine.remove(); S.trackLine = null; }
    S.hike = null; clearInterval(S.hikeTimer);
    $('#hikeStats').hidden = true;
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
      let txt = `Trail ended: ${h.name}. ${fmtDur(Date.now() - h.t0)}, ${fmtMi(h.dist)} walked.`;
      if (h.fixes) txt += h.maxOff <= 15 ? ' You stayed on the trail the whole way.' : ` The furthest you got from the trail was ${fmtOff(h.maxOff)}.`;
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
    if (e.code === 1) { areaStatus(locError(e), true); stopTracking(true); }
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
    S.me = L.latLng(lat, lon);
    if (!S.meMarker) {
      S.accCircle = L.circle(S.me, { radius: acc, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(S.map);
      S.meMarker = L.marker(S.me, { icon: L.divIcon({ className: 'mk-me', iconSize: [18, 18] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(S.map);
    } else { S.meMarker.setLatLng(S.me); S.accCircle.setLatLng(S.me).setRadius(acc); }
    if (S.follow) S.map.setView(S.me, Math.max(S.map.getZoom(), 17), { animate: false });

    const near = nearestOnSegs(m.proj.x(lon), m.proj.y(lat), m.segs, targetIdx());
    const nll = L.latLng(m.proj.lat(near.y), m.proj.lon(near.x));
    const thr = +$('#warnDist').value;
    const chip = $('#gpsChip');
    if (near.d > 3000) {
      chip.className = 'gps-chip'; chip.textContent = `You're ${fmtMi(near.d)} from this trail`;
      $('#alert').hidden = true; if (S.offLine) { S.offLine.remove(); S.offLine = null; }
      S.off = false; S.offCount = 0; return;
    }
    if (acc > 50) { chip.className = 'gps-chip bad'; chip.textContent = `Weak GPS (±${Math.round(acc)} m), warnings paused`; return; }
    recordFix(lat, lon, near.d);
    if (near.d > thr) S.offCount++; else if (near.d <= thr * 0.75) S.offCount = 0;
    if (!S.off && S.offCount >= 2) { S.off = true; S.lastAlert = 0; }
    if (S.off && near.d <= thr * 0.75) { S.off = false; showBackOn(); }
    if (S.off) {
      const dir = bearingName(lat, lon, nll.lat, nll.lng);
      chip.className = 'gps-chip bad'; chip.textContent = `Off trail · ${fmtOff(near.d)}`;
      $('#alertTitle').textContent = 'Off trail';
      $('#alertText').textContent = `The trail is ${fmtOff(near.d)} to the ${dir}. Follow the red dashed line.`;
      const a = $('#alert'); a.classList.remove('back'); a.hidden = false;
      if (!S.offLine) S.offLine = L.polyline([S.me, nll], { color: COLORS().danger, weight: 4, dashArray: '8 8', interactive: false }).addTo(S.map);
      else S.offLine.setLatLngs([S.me, nll]);
      if (Date.now() - S.lastAlert > 45000) { S.lastAlert = Date.now(); beep(); }
    } else if (near.d > thr) {
      chip.className = 'gps-chip'; chip.textContent = `Checking · ${fmtOff(near.d)} from the trail · GPS ±${Math.round(acc)} m`;
    } else {
      chip.className = 'gps-chip ok'; chip.textContent = `On trail · ${fmtOff(near.d)} from the line · GPS ±${Math.round(acc)} m`;
      if (S.offLine) { S.offLine.remove(); S.offLine = null; }
    }
  }

  function recordFix(lat, lon, off) {
    const h = S.hike; if (!h) return;
    h.fixes++;
    if (!h.start && off < 60) h.start = [lat, lon];
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

  let backTimer = null;
  function showBackOn() {
    const a = $('#alert'); a.classList.add('back'); a.hidden = false;
    $('#alertTitle').textContent = 'Back on trail'; $('#alertText').textContent = 'You\'re back near the trail.';
    clearTimeout(backTimer); backTimer = setTimeout(() => { if (!S.off) a.hidden = true; }, 4000);
  }

  /* ---------------- way back ---------------- */
  function clearRoute() { if (S.routeLayer) { S.routeLayer.remove(); S.routeLayer = null; } }

  // Shortest way along the trails to mapped parking, or else to where this walk started.
  function routeHome() {
    const m = S.model; if (!m) return;
    clearRoute();
    const from = S.me;
    if (!from) { areaStatus('Tap Start trail first so the app knows where you are.', true); return; }
    let targets = (S.extras || []).filter((p) => p.kind === 'parking').map((p) => ({ lat: p.lat, lon: p.lon, name: p.name || 'parking' }));
    if (!targets.length && S.hike && S.hike.start) targets = [{ lat: S.hike.start[0], lon: S.hike.start[1], name: 'where you started' }];
    if (!targets.length) { areaStatus('No parking is mapped here, and your walk has no start point yet.', true); return; }
    const near = nearestOnSegs(m.proj.x(from.lng), m.proj.y(from.lat), m.segs);
    const N = m.coords.length, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
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
      areaStatus(`The trails here don't connect to ${p.name}, so this line is a straight direction only. Follow the park's signs.`, true);
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
    areaStatus(`Way back to ${best.p.name}: about ${fmtMi(best.tot + near.d)} along the trails (blue line).`);
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

  /* ---------------- GPX ---------------- */
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function download(text, name) {
    const blob = new Blob([text], { type: 'application/gpx+xml' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.gpx' });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function gpx() {
    const m = S.model; if (!m) return;
    const x = (s) => escapeHtml(String(s));
    const grp = S.selected != null ? m.groups[S.selected] : null;
    const wl = grp ? grp.ways.map((wi) => m.ways[wi]) : m.ways;
    const trk = wl.map((w) => `<trk><name>${x(w.f.name || 'Trail')}</name><desc>${x(SURF_WORD[w.cls])}</desc><trkseg>${w.ll.map((p) => `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"/>`).join('')}</trkseg></trk>`).join('\n');
    const title = grp ? grp.name + ', ' + m.info.name : m.info.name;
    download(`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Trail Mapper" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${x(title)}</name><desc>Trail lines: Florida DEP Office of Greenways and Trails</desc></metadata>\n${trk}\n</gpx>`, title);
  }
  function walkGpx() {
    const h = S.hike; if (!h || h.pts.length < 2) return;
    const x = (v) => escapeHtml(String(v));
    download(`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Trail Mapper" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${x(h.name)} walk</name><trkseg>${h.pts.map((p) => `<trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`).join('')}</trkseg></trk>\n</gpx>`, h.name + ' walk');
  }

  /* ---------------- routing by hash ---------------- */
  function route() {
    const mt = /^#\/park\/([^/]+)(?:\/t\/(.+))?$/.exec(location.hash);
    if (mt) {
      let key, tk = null;
      try { key = decodeURIComponent(mt[1]); tk = mt[2] ? decodeURIComponent(mt[2]) : null; } catch (e) { return; }
      if (S.park === key) {
        if (S.model) { const gi = findGroup(S.model, tk); if (gi !== (S.selected == null ? -1 : S.selected)) highlightGroup(gi >= 0 ? gi : null, { noHash: true }); }
        return;
      }
      openPark(key, tk, true);
    } else if (!$('#viewArea').hidden) backToFind();
  }

  /* ---------------- wire up ---------------- */
  function rediscover() {
    if (S.radius === 0) discover(null, null, 'South Florida');
    else if (S.center) discover(S.center.lat, S.center.lon, S.center.label);
    else nearMe();
  }

  function init() {
    setRadius(S.radius);
    setMode(S.mode);
    const who = store.get('who', 'both'); if ([...$('#whoFilter').options].some((o) => o.value === who)) $('#whoFilter').value = who;
    document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { setRadius(+c.dataset.r); rediscover(); }));
    $('#nearMe').addEventListener('click', nearMe);
    $('#searchForm').addEventListener('submit', onSearch);
    ['#surfFilter', '#sortBy', '#favOnly'].forEach((s) => $(s).addEventListener('change', renderList));
    $('#whoFilter').addEventListener('change', () => { store.set('who', $('#whoFilter').value); if (S.radius === 0 || S.center) rediscover(); });
    document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); renderList(); }));
    $('#backBtn').addEventListener('click', () => { history.pushState(null, '', location.pathname); backToFind(); });
    $('#favBtn').addEventListener('click', () => {
      if (!S.park) return;
      if (S.favs[S.park]) delete S.favs[S.park]; else S.favs[S.park] = 1;
      store.set('favs', S.favs); setFav();
    });
    $('#followBtn').addEventListener('click', () => { if (!S.me) { areaStatus('Tap Start trail to see your position.'); return; } setFollow(!S.follow); });
    $('#fitBtn').addEventListener('click', () => { if (S.model) S.map.fitBounds(S.model.bounds, { padding: [30, 30] }); setFollow(false); });
    $('#trackBtn').addEventListener('click', () => (S.watchId == null ? startTracking() : stopTracking(false)));
    $('#walkGpx').addEventListener('click', walkGpx);
    $('#allTrailsBtn').addEventListener('click', () => highlightGroup(null));
    $('#homeBtn').addEventListener('click', routeHome);
    $('#alertRoute').addEventListener('click', () => { if (S.me && S.offLine) { S.map.fitBounds(S.offLine.getBounds(), { padding: [60, 60], maxZoom: 19 }); setFollow(false); } });
    $('#sheetHandle').addEventListener('click', () => { const s = $('#sheet'); s.dataset.open = s.dataset.open === 'true' ? 'false' : 'true'; });
    $('#warnTarget').addEventListener('change', () => { if (S.park) store.set('warn:' + S.park, $('#warnTarget').value); S.offCount = 0; });
    $('#gpxBtn').addEventListener('click', gpx);
    $('#refreshBtn').addEventListener('click', () => {
      if (!S.park) return;
      const keep = S.selected != null && S.model ? S.model.groups[S.selected].key : null;
      openPark(S.park, keep, true, true);
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeLock(); });
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);

    const c = store.get('center', null);
    if (S.radius === 0) discover(null, null, 'South Florida');
    else if (c && c.lat != null) { S.center = c; discover(c.lat, c.lon, c.label); }
    else findStatus('Tap Trails near me, pick All South Florida, or search a park, trail or city.');
    renderSaved();
    route();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
  }

  if (typeof window.__TM_TEST__ !== 'undefined') window.__TM_TEST__ = { slim, buildParks, buildModel, groupShape, nearestOnSegs, surfClass, agencyKind, fmtMi };
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
