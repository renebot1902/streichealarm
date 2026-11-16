/* =====================================================================
   STREICHE ALARM – Renderer (2.5D-Isometrie im Cartoon-Vektor-Look)
   Reines Canvas 2D, keine Bilddateien, keine Bibliotheken.
   Stellt ausschließlich window.Render bereit (siehe SPEC.md §6).
   ===================================================================== */
(function () {
  'use strict';

  // ---------- Grundkonstanten ----------
  const HW = 32;            // halbe Kachelbreite (Iso-Pixel bei Zoom 1)
  const HH = 16;            // halbe Kachelhöhe
  const ZH = 34;            // Pixel pro Höheneinheit
  const WALL_H = 0.62;      // niedrige Cutaway-Wände
  const TAU = Math.PI * 2;
  const ERX = HW * Math.SQRT2, ERY = HH * Math.SQRT2; // Ellipsen-Halbachsen für Welt-Radius 1
  const FONT = '"Fredoka", "Nunito", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';
  const T_FLOOR = 1, T_WALL = 2, T_DOOR = 3, T_EXIT = 4;

  // ---------- Interner Zustand ----------
  const R = {
    canvas: null, ctx: null, dpr: 1, cw: 1, ch: 1,
    cat: null, world: null, map: null,
    baseScale: 1, scale: 1, zoom: 1,
    camX: 0, camY: 0, camInit: false,
    k: 1, tx: 0, ty: 0,                 // letzter Welt-Transform
    shakeAmp: 0, shakeX: 0, shakeY: 0,
    t: 0, dt: 1 / 60, lastT: null,
    floor: null, floorWanted: 0, floorBuiltAt: -10, zoomChangedAt: -10,
    statics: [], visBuf: [], ovl: [],
    bright: new Set(), brightKey: '',
    tileSolid: null, waterSet: null, waterList: [],
    devById: new Map(), hideById: new Map(),
    robotPos: new Map(),
    fxStart: new Map(), emoStart: new Map(),
    parts: [], floats: [],
    vign: null, vignKey: '',
    bgGrad: null, bgKey: '',
    meX: 0, meY: 0, haveMe: false,
    miniCache: null, miniKey: ''
  };

  // ---------- Hilfsfunktionen ----------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function hash(a, b, c) {
    let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2147483647;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 100000) / 100000;
  }
  function strHash(s) {
    s = String(s || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }

  // ---------- Farben (mit Fog-Abdunklung) ----------
  const _rgb = new Map();
  function rgb(hex) {
    let c = _rgb.get(hex);
    if (c) return c;
    let h = String(hex || '#888888').trim();
    if (h[0] === '#') h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h.slice(0, 6), 16);
    c = isNaN(n) ? [136, 136, 136] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    _rgb.set(hex, c);
    return c;
  }
  function toHex(r, g, b) {
    return '#' + ((1 << 24) | (clamp(r | 0, 0, 255) << 16) | (clamp(g | 0, 0, 255) << 8) | clamp(b | 0, 0, 255)).toString(16).slice(1);
  }
  const FOG = [14, 18, 44], FOGA = 0.55;
  let DIM = false;          // aktuelles Objekt liegt im Nebel
  const _sh = new Map();
  /** Farbe aufhellen (k>0) oder abdunkeln (k<0); berücksichtigt den Nebel. */
  function sh(hex, k) {
    const key = hex + '|' + Math.round((k || 0) * 100) + (DIM ? 'd' : '');
    let s = _sh.get(key);
    if (s) return s;
    let [r, g, b] = rgb(hex);
    k = k || 0;
    if (k > 0) { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
    else if (k < 0) { r *= 1 + k; g *= 1 + k; b *= 1 + k; }
    if (DIM) { r = r * (1 - FOGA) + FOG[0] * FOGA; g = g * (1 - FOGA) + FOG[1] * FOGA; b = b * (1 - FOGA) + FOG[2] * FOGA; }
    s = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
    if (_sh.size > 6000) _sh.clear();
    _sh.set(key, s);
    return s;
  }
  /** Farbe mit Transparenz. */
  function rgba(hex, a) {
    let [r, g, b] = rgb(hex);
    if (DIM) { r = r * (1 - FOGA) + FOG[0] * FOGA; g = g * (1 - FOGA) + FOG[1] * FOGA; b = b * (1 - FOGA) + FOG[2] * FOGA; }
    return 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a + ')';
  }
  /** Zwei Hex-Farben mischen → Hex (t gerundet, damit Caches klein bleiben). */
  const _mix = new Map();
  function mix(a, b, t) {
    t = Math.round(clamp(t, 0, 1) * 20) / 20;
    const key = a + b + t;
    let m = _mix.get(key);
    if (m) return m;
    const A = rgb(a), B = rgb(b);
    m = toHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
    if (_mix.size > 4000) _mix.clear();
    _mix.set(key, m);
    return m;
  }

  // ---------- Iso-Pfad-Helfer (C = aktueller Kontext) ----------
  let C = null;
  let OUTL = 'rgba(30,22,52,0.55)';
  let LW = 1;
  let HL = false;           // Hervorhebung (Gerät in Reichweite)
  function isoX(x, y) { return (x - y) * HW; }
  function isoY(x, y, z) { return (x + y) * HH - (z || 0) * ZH; }
  function mv(x, y, z) { C.moveTo((x - y) * HW, (x + y) * HH - z * ZH); }
  function ln(x, y, z) { C.lineTo((x - y) * HW, (x + y) * HH - z * ZH); }
  function strokeOut(w) {
    C.lineWidth = (w || LW) * (HL ? 1.9 : 1);
    C.strokeStyle = HL ? '#ffd84a' : (DIM ? 'rgba(10,12,30,0.5)' : OUTL);
    C.stroke();
  }
  function fillOut(fill, stroke) {
    C.fillStyle = fill;
    C.fill();
    if (stroke !== false) strokeOut(typeof stroke === 'number' ? stroke : 0);
  }
  /** Viereck aus vier 3D-Punkten. */
  function quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, fill, stroke) {
    C.beginPath(); mv(ax, ay, az); ln(bx, by, bz); ln(cx, cy, cz); ln(dx, dy, dz); C.closePath();
    fillOut(fill, stroke);
  }
  /** Achsparalleler Quader. faces: Bitmaske 1=oben 2=+y-Seite 4=+x-Seite. */
  function box(x0, y0, x1, y1, z0, z1, col, faces, topCol, stroke) {
    if (faces === undefined || faces === null) faces = 7;
    if (faces & 2) quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, sh(col, -0.05), stroke);
    if (faces & 4) quad(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, sh(col, -0.26), stroke);
    if (faces & 1) quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, topCol ? sh(topCol, 0) : sh(col, 0.16), stroke);
  }
  /** Senkrechter Zylinder. */
  function cyl(x, y, z, r, h, col, topCol, stroke) {
    const cx = (x - y) * HW, cyb = (x + y) * HH - z * ZH, cyt = cyb - h * ZH, rx = r * ERX, ry = r * ERY;
    C.beginPath();
    C.moveTo(cx - rx, cyt);
    C.lineTo(cx - rx, cyb);
    C.ellipse(cx, cyb, rx, ry, 0, Math.PI, 0, true);
    C.lineTo(cx + rx, cyt);
    C.ellipse(cx, cyt, rx, ry, 0, 0, Math.PI, false);
    C.closePath();
    fillOut(sh(col, -0.14), stroke);
    // Glanzstreifen
    C.fillStyle = DIM ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.18)';
    C.fillRect(cx - rx * 0.62, cyt + ry * 0.8, rx * 0.2, h * ZH);
    C.beginPath();
    C.ellipse(cx, cyt, rx, ry, 0, 0, TAU);
    fillOut(topCol ? sh(topCol, 0) : sh(col, 0.14), stroke);
  }
  /** Flache Ellipse (Welt-Kreis) auf Höhe z. */
  function ell(x, y, z, r, fill, stroke, ry2) {
    C.beginPath();
    C.ellipse((x - y) * HW, (x + y) * HH - z * ZH, r * ERX, (ry2 || r) * ERY, 0, 0, TAU);
    C.fillStyle = fill; C.fill();
    if (stroke) strokeOut(typeof stroke === 'number' ? stroke : 0);
  }
  /** Kugel/Klecks im Bildschirm-Raum (Radius in Iso-Pixeln). */
  function blob(x, y, z, rp, col, stroke) {
    const cx = (x - y) * HW, cy = (x + y) * HH - z * ZH;
    C.beginPath(); C.arc(cx, cy, rp, 0, TAU);
    C.fillStyle = sh(col, 0); C.fill();
    if (stroke !== false) strokeOut(0.8);
    C.beginPath(); C.arc(cx - rp * 0.35, cy - rp * 0.35, rp * 0.35, 0, TAU);
    C.fillStyle = DIM ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.35)'; C.fill();
  }

  // ---------- Lokales Geräte-Koordinatensystem ----------
  // u = Breite (links→rechts am Bildschirm), v = Tiefe (0 = Vorderkante, 1 = Wandseite), z = Höhe
  let LX = 0, LY = 0, LF = 'S', WX = 0, WY = 0;
  function L(u, v) {
    if (LF === 'S') { WX = LX + u; WY = LY + 1 - v; }
    else { WX = LX + 1 - v; WY = LY + 1 - u; }
  }
  function lmv(u, v, z) { L(u, v); mv(WX, WY, z); }
  function lln(u, v, z) { L(u, v); ln(WX, WY, z); }
  function lbox(u0, v0, u1, v1, z0, z1, col, faces, topCol) {
    L(u0, v0); const ax = WX, ay = WY; L(u1, v1);
    box(Math.min(ax, WX), Math.min(ay, WY), Math.max(ax, WX), Math.max(ay, WY), z0, z1, col, faces, topCol);
  }
  /** Fläche in der Frontebene (Tiefe v). */
  function lfront(u0, u1, z0, z1, v, fill, stroke) {
    C.beginPath(); lmv(u0, v, z0); lln(u1, v, z0); lln(u1, v, z1); lln(u0, v, z1); C.closePath();
    fillOut(fill, stroke);
  }
  /** Waagrechte Fläche. */
  function ltop(u0, v0, u1, v1, z, fill, stroke) {
    C.beginPath(); lmv(u0, v0, z); lln(u1, v0, z); lln(u1, v1, z); lln(u0, v1, z); C.closePath();
    fillOut(fill, stroke);
  }
  /** Seitenfläche (Ebene u = const) – nur sichtbar wenn zur Kamera. */
  function lside(u, v0, v1, z0, z1, fill, stroke) {
    C.beginPath(); lmv(u, v0, z0); lln(u, v1, z0); lln(u, v1, z1); lln(u, v0, z1); C.closePath();
    fillOut(fill, stroke);
  }
  function lcyl(u, v, z, r, h, col, topCol, stroke) { L(u, v); cyl(WX, WY, z, r, h, col, topCol, stroke); }
  function lell(u, v, z, r, fill, stroke) { L(u, v); ell(WX, WY, z, r, fill, stroke); }
  function lblob(u, v, z, rp, col, stroke) { L(u, v); blob(WX, WY, z, rp, col, stroke); }
  /** Kreis in der Frontebene. */
  function lcirc(u, z, r, v, fill, stroke) {
    C.beginPath();
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * TAU;
      if (i === 0) lmv(u + Math.cos(a) * r, v, z + Math.sin(a) * r);
      else lln(u + Math.cos(a) * r, v, z + Math.sin(a) * r);
    }
    C.closePath();
    fillOut(fill, stroke);
  }
  /** Linie in Weltkoordinaten (lokal). */
  function lline(u0, v0, z0, u1, v1, z1, col, w) {
    C.beginPath(); lmv(u0, v0, z0); lln(u1, v1, z1);
    C.lineWidth = w || 1; C.strokeStyle = col; C.stroke();
  }
  /** Bildschirmposition eines lokalen Punktes. */
  function lpt(u, v, z) { L(u, v); return [(WX - WY) * HW, (WX + WY) * HH - z * ZH]; }

  // ---------- Emoji-Cache (scharf bei jedem DPR) ----------
  const _emo = new Map();
  function emojiImg(e, px) {
    px = Math.max(8, Math.min(256, Math.round(px / 2) * 2));
    const key = e + '|' + px;
    let c = _emo.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    const s = Math.ceil(px * 1.3);
    c.width = s; c.height = s;
    const g = c.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = px + 'px ' + EMOJI_FONT;
    g.fillText(e, s / 2, s / 2 + px * 0.06);
    if (_emo.size > 400) _emo.clear();
    _emo.set(key, c);
    return c;
  }
  /** Emoji zeichnen; size in aktuellen Kontext-Einheiten, pxScale = Gerätepixel pro Einheit. */
  function drawEmoji(g, e, x, y, size, pxScale, alpha) {
    if (!e) return;
    const img = emojiImg(e, size * (pxScale || 1));
    const s = size * 1.3;
    if (alpha !== undefined && alpha < 1) { const a = g.globalAlpha; g.globalAlpha = a * alpha; g.drawImage(img, x - s / 2, y - s / 2, s, s); g.globalAlpha = a; }
    else g.drawImage(img, x - s / 2, y - s / 2, s, s);
  }
  /** Abgerundetes Rechteck (Pfad). */
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // =====================================================================
  //  Welt: Katalog-Lookups, statische Objekte, Boden-Cache, Nebel
  // =====================================================================

  const FALLBACK_BLD = {
    buero:       { wall: '#eef1f7', wallTop: '#55648c', outside: '#7db36b' },
    krankenhaus: { wall: '#f1f8f8', wallTop: '#3f8d99', outside: '#86b97a' },
    villa:       { wall: '#f7efe3', wallTop: '#8b6a50', outside: '#77b660' },
    baumarkt:    { wall: '#ebe8e1', wallTop: '#c9622a', outside: '#9aa3ad' },
    uebung:      { wall: '#eef0f8', wallTop: '#7a5cc9', outside: '#78b46a' }
  };
  const PATTERN_GUESS = [
    [/wc|bad|toilet/, { floor: '#dfe9f2', floor2: '#c7d6e4', pattern: 'tiles' }],
    [/kueche|kaffee|stations/, { floor: '#f3e3c8', floor2: '#e2c9a2', pattern: 'tiles' }],
    [/flur|gang/, { floor: '#d9d4e8', floor2: '#c8c1dc', pattern: 'linoleum' }],
    [/garten|terrasse/, { floor: '#7fc46a', floor2: '#5ea34d', pattern: 'grass', outdoor: true }],
    [/pool/, { floor: '#c79a6b', floor2: '#b2875a', pattern: 'deck', outdoor: true }],
    [/lager|paket/, { floor: '#b9bec6', floor2: '#a3a9b3', pattern: 'concrete' }],
    [/roentgen|untersuch|verband|warte/, { floor: '#d6efe9', floor2: '#bfe2da', pattern: 'linoleum' }],
    [/chef|wohn|schlaf|eingang/, { floor: '#c8956a', floor2: '#b07d55', pattern: 'wood' }],
    [/konferenz|grossraum|kopier/, { floor: '#8fa3c7', floor2: '#7d92b8', pattern: 'carpet' }]
  ];

  function bld() {
    const m = R.map;
    const id = m ? m.building : 'buero';
    const c = R.cat && R.cat.buildings && R.cat.buildings[id];
    const f = FALLBACK_BLD[id] || FALLBACK_BLD.buero;
    if (!c) return f;
    return { wall: c.wall || f.wall, wallTop: c.wallTop || f.wallTop, outside: c.outside || f.outside, rooms: c.rooms, disguise: c.disguise };
  }
  function roomStyle(room) {
    if (!room) return { floor: '#cfd5df', floor2: '#bcc4d2', pattern: 'tiles' };
    if (room._st) return room._st;
    const b = R.cat && R.cat.buildings && R.map && R.cat.buildings[R.map.building];
    let st = b && b.rooms && b.rooms[room.type];
    if (!st) {
      st = { floor: '#cdd3e0', floor2: '#b9c1d3', pattern: 'carpet' };
      for (const [re, s] of PATTERN_GUESS) if (re.test(room.type || '')) { st = s; break; }
    }
    st = Object.assign({ floor: '#cdd3e0', floor2: '#b9c1d3', pattern: 'tiles' }, st);
    if (room.outdoor) st.outdoor = true;
    room._st = st;
    return st;
  }
  function tileAt(i, j) {
    const m = R.map;
    if (!m || i < 0 || j < 0 || i >= m.w || j >= m.h) return 0;
    return m.tiles[j * m.w + i];
  }
  function roomAt(i, j) {
    const m = R.map;
    if (!m || i < 0 || j < 0 || i >= m.w || j >= m.h) return -1;
    return m.roomId[j * m.w + i];
  }
  function isWallish(t) { return t === T_WALL || t === T_EXIT; }
  function deviceType(type) {
    return (R.cat && R.cat.deviceTypes && R.cat.deviceTypes[type]) || null;
  }

  /** Blickrichtung eines Möbels: weg von der angrenzenden Wand. */
  function facingFor(x, y) {
    const W = (i, j) => { const t = tileAt(i, j); return t === T_WALL || t === T_EXIT || t === 0; };
    const n = W(x, y - 1), s = W(x, y + 1), w = W(x - 1, y), e = W(x + 1, y);
    if ((w || e) && !(n || s)) return 'E';
    if ((n || s) && !(w || e)) return 'S';
    if (n) return 'S';
    if (w) return 'E';
    return 'S';
  }

  function setWorld(world) {
    R.world = world || null;
    R.map = (world && world.map) || null;
    R.statics = [];
    R.floor = null;
    R.miniCache = null; R.miniKey = '';
    R.devById.clear(); R.hideById.clear(); R.robotPos.clear();
    R.fxStart.clear(); R.emoStart.clear();
    R.parts.length = 0; R.floats.length = 0;
    R.camInit = false;
    R.brightKey = '';
    const m = R.map;
    if (!m) return;
    if (!m.roomId) m.roomId = new Array(m.w * m.h).fill(-1);
    if (!m.doors) m.doors = [];
    if (!m.devices) m.devices = [];
    if (!m.hides) m.hides = [];
    if (!m.decor) m.decor = [];
    for (const r of m.rooms) r._st = null;

    // Türen nach Index
    R.doorAt = new Map();
    for (const d of m.doors) R.doorAt.set(d.y * m.w + d.x, d);
    // Wasser
    R.waterSet = new Set(); R.waterList = [];
    for (const d of m.decor) if (d.type === 'wasser') { R.waterSet.add(d.y * m.w + d.x); R.waterList.push(d); }

    const st = R.statics;
    // --- Wände ---
    for (let j = 0; j < m.h; j++) {
      for (let i = 0; i < m.w; i++) {
        const t = m.tiles[j * m.w + i];
        if (t !== T_WALL) continue;
        const rooms = new Set(), front = new Set();
        let anyIndoor = false, anyRoom = false;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const tt = tileAt(i + di, j + dj);
          let ids = null;
          if (tt === T_FLOOR) { const r = roomAt(i + di, j + dj); if (r >= 0) ids = [r]; }
          else if (tt === T_DOOR) { const d = R.doorAt.get((j + dj) * m.w + i + di); if (d) ids = [d.a, d.b]; }
          if (!ids) continue;
          for (const r of ids) {
            if (r < 0) continue;
            rooms.add(r); anyRoom = true;
            const ro = m.rooms[r];
            if (ro && !ro.outdoor) anyIndoor = true;
            // Raum liegt nördlich/westlich → diese Wand ist seine Vorderwand
            if ((dj === -1 && di >= -1 && di <= 1) || (di === -1 && dj >= -1 && dj <= 1)) front.add(r);
          }
        }
        const hedge = anyRoom && !anyIndoor;
        st.push({
          k: 'wall', i, j, x: i + 0.5, y: j + 0.5, d: i + j + 1,
          rooms: [...rooms], front: [...front], hedge,
          f2: !isWallish(tileAt(i, j + 1)), f4: !isWallish(tileAt(i + 1, j)),
          h: hedge ? 0.5 : WALL_H, ht: hedge ? 0.5 : WALL_H
        });
      }
    }
    // --- Türpfosten ---
    for (const d of m.doors) {
      const alongX = isWallish(tileAt(d.x - 1, d.y)) || isWallish(tileAt(d.x + 1, d.y)) || tileAt(d.x - 1, d.y) === T_DOOR || tileAt(d.x + 1, d.y) === T_DOOR;
      const rooms = [d.a, d.b];
      if (alongX) {
        if (isWallish(tileAt(d.x - 1, d.y))) st.push({ k: 'post', x: d.x, y: d.y + 0.5, d: d.x + d.y + 0.55, ax: 'x', rooms, wt: (d.y * m.w + d.x - 1) });
        if (isWallish(tileAt(d.x + 1, d.y))) st.push({ k: 'post', x: d.x + 1, y: d.y + 0.5, d: d.x + d.y + 1.55, ax: 'x', rooms, wt: (d.y * m.w + d.x + 1) });
      } else {
        if (isWallish(tileAt(d.x, d.y - 1))) st.push({ k: 'post', x: d.x + 0.5, y: d.y, d: d.x + d.y + 0.55, ax: 'y', rooms, wt: ((d.y - 1) * m.w + d.x) });
        if (isWallish(tileAt(d.x, d.y + 1))) st.push({ k: 'post', x: d.x + 0.5, y: d.y + 1, d: d.x + d.y + 1.55, ax: 'y', rooms, wt: ((d.y + 1) * m.w + d.x) });
      }
    }
    // --- Ausgang ---
    if (m.exit) {
      const ex = m.exit;
      const dir = ex.dir || 's';
      const inn = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0] }[dir] || [0, -1];
      const ir = roomAt(ex.x + inn[0], ex.y + inn[1]);
      R.exitInner = { x: ex.x + inn[0], y: ex.y + inn[1] };
      st.push({ k: 'exit', i: ex.x, j: ex.y, x: ex.x + 0.5, y: ex.y + 0.5, d: ex.x + ex.y + 1, rooms: ir >= 0 ? [ir] : [], dir });
    }
    // --- Geräte ---
    for (const dv of m.devices) {
      R.devById.set(dv.id, dv);
      const dt = deviceType(dv.type);
      if ((dt && dt.mobile) || dv.type === 'saugroboter') { R.robotPos.set(dv.id, { x: dv.x + 0.5, y: dv.y + 0.5, d: 0, seen: false }); continue; }
      st.push({ k: 'dev', o: dv, x: dv.x + 0.5, y: dv.y + 0.5, d: dv.x + dv.y + 1, f: facingFor(dv.x, dv.y), rooms: [dv.room] });
    }
    for (const hd of m.hides) {
      R.hideById.set(hd.id, hd);
      st.push({ k: 'hide', o: hd, x: hd.x + 0.5, y: hd.y + 0.5, d: hd.x + hd.y + 1, f: facingFor(hd.x, hd.y), rooms: [hd.room] });
    }
    for (const dc of m.decor) {
      if (dc.type === 'wasser') continue;
      const r = roomAt(dc.x, dc.y);
      st.push({ k: 'decor', o: dc, x: dc.x + 0.5, y: dc.y + 0.5, d: dc.x + dc.y + 1, f: facingFor(dc.x, dc.y), rooms: r >= 0 ? [r] : [] });
    }
    const wallIdx = new Map();
    for (const o of st) if (o.k === 'wall') wallIdx.set(o.j * m.w + o.i, o);
    for (const o of st) {
      o.ax0 = isoX(o.x, o.y); o.ay0 = isoY(o.x, o.y, 0); o.alpha = 1;
      if (o.k === 'post') o.wall = wallIdx.get(o.wt) || null;
    }
    st.sort((a, b) => a.d - b.d);
    R.mapCenter = { x: m.w / 2, y: m.h / 2 };
  }

  function clearWorld() { setWorld(null); }

  // ---------------------------------------------------------------------
  //  Boden-Cache (Offscreen-Canvas im Iso-Raum, Muster in Weltkoordinaten)
  // ---------------------------------------------------------------------
  function buildFloor(cs) {
    const m = R.map;
    if (!m) return null;
    const pad = 40;
    const isoW = (m.w + m.h) * HW + pad * 2, isoH = (m.w + m.h) * HH + pad * 2;
    const wantCs = cs;
    // GPU-freundliche Grenzen: max. 4096 px Kantenlänge und ~8 Mio. Pixel
    const area = isoW * isoH * cs * cs;
    const maxPx = 8e6;
    if (area > maxPx) cs *= Math.sqrt(maxPx / area);
    cs = Math.min(cs, 4096 / isoW, 4096 / isoH);
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(isoW * cs); cv.height = Math.ceil(isoH * cs);
    const g = cv.getContext('2d');
    const ox = m.h * HW + pad, oy = pad;
    const prevC = C, prevDim = DIM;
    C = g; DIM = false;
    g.setTransform(cs, 0, 0, cs, ox * cs, oy * cs);
    g.save();
    g.transform(HW, HH, -HW, HH, 0, 0);   // ab hier: Weltkoordinaten

    // Fundament unter dem Gebäude (leichter Sockel)
    const b = bld();
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(0.25, 0.35, m.w, m.h);

    for (const room of m.rooms) drawRoomFloor(g, room);
    drawDoorFloors(g, b);
    drawWater(g);
    drawTeamTint(g);
    drawFloorShadows(g);
    drawExitMat(g);
    drawRoomLabels(g);
    g.restore();
    C = prevC; DIM = prevDim;
    return { canvas: cv, cs, ox, oy, wantCs };
  }

  function rectFill(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }

  function drawRoomFloor(g, room) {
    const st = roomStyle(room);
    const A = st.floor, B = st.floor2 || sh(A, -0.08);
    const x0 = room.x, y0 = room.y, w = room.w, h = room.h;
    const seed = room.id * 97 + 13;
    const pat = st.pattern || 'tiles';
    g.save();
    g.beginPath(); g.rect(x0 - 0.02, y0 - 0.02, w + 0.04, h + 0.04); g.clip();
    if (pat === 'tiles') {
      rectFill(g, x0, y0, w, h, sh(A, -0.14));
      for (let j = 0; j < h * 2; j++) for (let i = 0; i < w * 2; i++) {
        const c = ((i + j) & 1) ? B : A;
        rectFill(g, x0 + i * 0.5 + 0.018, y0 + j * 0.5 + 0.018, 0.464, 0.464, c);
        rectFill(g, x0 + i * 0.5 + 0.03, y0 + j * 0.5 + 0.03, 0.44, 0.07, 'rgba(255,255,255,0.12)');
      }
    } else if (pat === 'wood') {
      rectFill(g, x0, y0, w, h, sh(A, -0.32));
      const pw = 0.25;
      for (let r = 0; r * pw < h; r++) {
        let x = x0 - hash(seed, r, 1) * 1.6;
        let n = 0;
        while (x < x0 + w) {
          const len = 1.1 + hash(seed, r, n + 7) * 1.5;
          const v = hash(seed, r, n + 31);
          const col = mix(A, B, v);
          rectFill(g, x + 0.012, y0 + r * pw + 0.012, len - 0.024, pw - 0.024, col);
          rectFill(g, x + 0.05, y0 + r * pw + 0.05, len * 0.6, 0.018, 'rgba(255,255,255,0.10)');
          rectFill(g, x + len * 0.3, y0 + r * pw + pw * 0.62, len * 0.5, 0.012, 'rgba(0,0,0,0.07)');
          x += len; n++;
        }
      }
    } else if (pat === 'deck') {
      rectFill(g, x0, y0, w, h, sh(A, -0.4));
      const pw = 0.333;
      for (let c = 0; c * pw < w; c++) {
        let y = y0 - hash(seed, c, 3) * 2;
        let n = 0;
        while (y < y0 + h) {
          const len = 1.6 + hash(seed, c, n + 5) * 1.6;
          const col = mix(A, B, hash(seed, c, n + 17));
          rectFill(g, x0 + c * pw + 0.025, y + 0.02, pw - 0.05, len - 0.04, col);
          rectFill(g, x0 + c * pw + 0.05, y + 0.06, 0.03, len * 0.7, 'rgba(255,255,255,0.12)');
          rectFill(g, x0 + c * pw + pw / 2 - 0.02, y + 0.08, 0.04, 0.04, 'rgba(60,40,20,0.45)');
          y += len; n++;
        }
      }
    } else if (pat === 'carpet') {
      rectFill(g, x0, y0, w, h, A);
      for (let j = 0; j < h * 3; j++) for (let i = 0; i < w * 3; i++) {
        if ((i + j) % 2) continue;
        rectFill(g, x0 + i / 3 + 0.12, y0 + j / 3 + 0.12, 0.09, 0.09, rgba(B, 0.55));
      }
      g.lineWidth = 0.09; g.strokeStyle = sh(A, -0.18);
      g.strokeRect(x0 + 0.2, y0 + 0.2, w - 0.4, h - 0.4);
      g.lineWidth = 0.03; g.strokeStyle = sh(A, 0.15);
      g.strokeRect(x0 + 0.32, y0 + 0.32, w - 0.64, h - 0.64);
    } else if (pat === 'grass') {
      rectFill(g, x0, y0, w, h, A);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        for (let k = 0; k < 10; k++) {
          const px = x0 + i + hash(seed + i, j, k), py = y0 + j + hash(seed + j, i, k + 50);
          const c = hash(i, j, k + 99) > 0.5 ? B : sh(A, 0.12);
          rectFill(g, px, py, 0.05, 0.13, c);
        }
        if (hash(seed, i * 7, j * 3) > 0.86) {
          const fx = x0 + i + 0.2 + hash(i, j, 3) * 0.6, fy = y0 + j + 0.2 + hash(j, i, 4) * 0.6;
          const fc = ['#ffffff', '#ffe066', '#ff8fb1', '#b39dfa'][Math.floor(hash(i, j, 9) * 4)];
          g.fillStyle = fc;
          for (let p = 0; p < 5; p++) { g.beginPath(); g.arc(fx + Math.cos(p * 1.256) * 0.06, fy + Math.sin(p * 1.256) * 0.06, 0.045, 0, TAU); g.fill(); }
          g.fillStyle = '#ffcc33'; g.beginPath(); g.arc(fx, fy, 0.035, 0, TAU); g.fill();
        }
      }
    } else if (pat === 'concrete') {
      rectFill(g, x0, y0, w, h, A);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        for (let k = 0; k < 8; k++) {
          const c = hash(i, j, k) > 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.10)';
          rectFill(g, x0 + i + hash(seed, i + k, j), y0 + j + hash(seed, j + k, i), 0.04, 0.04, c);
        }
      }
      for (let i = 2; i < w; i += 2) rectFill(g, x0 + i - 0.01, y0, 0.02, h, 'rgba(0,0,0,0.12)');
      for (let j = 2; j < h; j += 2) rectFill(g, x0, y0 + j - 0.01, w, 0.02, 'rgba(0,0,0,0.12)');
      // gelbe Sicherheitslinien am Rand (Baumarkt-Flair)
      g.lineWidth = 0.07; g.strokeStyle = 'rgba(255,200,40,0.65)';
      g.strokeRect(x0 + 0.35, y0 + 0.35, w - 0.7, h - 0.7);
    } else if (pat === 'linoleum') {
      rectFill(g, x0, y0, w, h, A);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        rectFill(g, x0 + i, y0 + j, 1, 0.012, 'rgba(0,0,0,0.06)');
        rectFill(g, x0 + i, y0 + j, 0.012, 1, 'rgba(0,0,0,0.06)');
        for (let k = 0; k < 6; k++) {
          const c = [B, '#ffffff', sh(A, -0.15)][k % 3];
          rectFill(g, x0 + i + hash(seed, i, j * 9 + k), y0 + j + hash(seed, j, i * 9 + k), 0.05, 0.03, rgba(c, 0.7));
        }
      }
      // Leitlinie in der Raummitte
      if (w > h) rectFill(g, x0, y0 + h / 2 - 0.04, w, 0.08, rgba(B, 0.9));
      else rectFill(g, x0 + w / 2 - 0.04, y0, 0.08, h, rgba(B, 0.9));
    } else if (pat === 'marble') {
      rectFill(g, x0, y0, w, h, A);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        if ((i + j) & 1) rectFill(g, x0 + i, y0 + j, 1, 1, rgba(B, 0.35));
        rectFill(g, x0 + i, y0 + j, 1, 0.014, 'rgba(0,0,0,0.08)');
        rectFill(g, x0 + i, y0 + j, 0.014, 1, 'rgba(0,0,0,0.08)');
        if (hash(seed, i, j) > 0.45) {
          g.beginPath();
          const sx0 = x0 + i + hash(i, j, 1) * 0.3, sy0 = y0 + j + hash(i, j, 2);
          g.moveTo(sx0, sy0);
          g.bezierCurveTo(sx0 + 0.3, sy0 - 0.3, sx0 + 0.5, sy0 + 0.2, sx0 + 0.95, sy0 - 0.25);
          g.lineWidth = 0.018; g.strokeStyle = 'rgba(120,110,130,0.28)'; g.stroke();
        }
        rectFill(g, x0 + i + 0.05, y0 + j + 0.05, 0.6, 0.05, 'rgba(255,255,255,0.18)');
      }
    } else {
      rectFill(g, x0, y0, w, h, A);
    }
    g.restore();
  }

  function drawDoorFloors(g, b) {
    const m = R.map;
    for (const d of m.doors) {
      const ra = m.rooms[d.a], rb = m.rooms[d.b];
      const ca = roomStyle(ra).floor, cb = roomStyle(rb).floor;
      rectFill(g, d.x, d.y, 1, 1, mix(ca, cb, 0.5));
      const alongX = isWallish(tileAt(d.x - 1, d.y)) || isWallish(tileAt(d.x + 1, d.y)) || tileAt(d.x - 1, d.y) === T_DOOR || tileAt(d.x + 1, d.y) === T_DOOR;
      const thr = sh(b.wallTop, 0.25);
      if (alongX) { rectFill(g, d.x, d.y + 0.2, 1, 0.6, thr); rectFill(g, d.x, d.y + 0.46, 1, 0.08, sh(b.wallTop, -0.1)); }
      else { rectFill(g, d.x + 0.2, d.y, 0.6, 1, thr); rectFill(g, d.x + 0.46, d.y, 0.08, 1, sh(b.wallTop, -0.1)); }
    }
  }

  function drawWater(g) {
    const m = R.map;
    for (const wt of R.waterList) {
      const i = wt.x, j = wt.y;
      const isW = (a, c) => R.waterSet.has(c * m.w + a);
      rectFill(g, i - 0.01, j - 0.01, 1.02, 1.02, '#29a0ec');
      // Bodenkacheln im Becken (dezent)
      rectFill(g, i + 0.02, j + 0.48, 0.96, 0.03, 'rgba(255,255,255,0.12)');
      rectFill(g, i + 0.48, j + 0.02, 0.03, 0.96, 'rgba(255,255,255,0.12)');
      // Beckenrand (heller Stein) + innerer Schatten
      if (!isW(i, j - 1)) { rectFill(g, i, j, 1, 0.14, '#f3efe6'); rectFill(g, i, j + 0.14, 1, 0.12, 'rgba(0,30,80,0.35)'); }
      if (!isW(i - 1, j)) { rectFill(g, i, j, 0.14, 1, '#f3efe6'); rectFill(g, i + 0.14, j, 0.12, 1, 'rgba(0,30,80,0.35)'); }
      if (!isW(i, j + 1)) rectFill(g, i, j + 0.86, 1, 0.14, '#e8e1d3');
      if (!isW(i + 1, j)) rectFill(g, i + 0.86, j, 0.14, 1, '#e8e1d3');
    }
  }

  function drawTeamTint(g) {
    const m = R.map;
    const teams = (R.cat && R.cat.teams) || [{ color: '#3b82f6' }, { color: '#f97316' }];
    for (const room of m.rooms) {
      if (room.team !== 0 && room.team !== 1) continue;
      const col = teams[room.team] ? teams[room.team].color : '#888888';
      rectFill(g, room.x, room.y, room.w, room.h, rgba(col, 0.09));
      g.lineWidth = 0.12; g.strokeStyle = rgba(col, 0.45);
      g.strokeRect(room.x + 0.08, room.y + 0.08, room.w - 0.16, room.h - 0.16);
    }
  }

  function drawFloorShadows(g) {
    const m = R.map;
    // Umgebungsverdeckung an Wänden + Schlagschatten (Licht von links oben)
    for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
      const t = m.tiles[j * m.w + i];
      if (t !== T_FLOOR && t !== T_DOOR) continue;
      if (R.waterSet.has(j * m.w + i)) continue;
      const wN = isWallish(tileAt(i, j - 1)), wW = isWallish(tileAt(i - 1, j));
      const wS = isWallish(tileAt(i, j + 1)), wE = isWallish(tileAt(i + 1, j));
      if (wN) { rectFill(g, i, j, 1, 0.42, 'rgba(20,10,40,0.07)'); rectFill(g, i, j, 1, 0.2, 'rgba(20,10,40,0.09)'); rectFill(g, i, j, 1, 0.08, 'rgba(20,10,40,0.1)'); }
      if (wW) { rectFill(g, i, j, 0.55, 1, 'rgba(20,10,40,0.08)'); rectFill(g, i, j, 0.26, 1, 'rgba(20,10,40,0.09)'); rectFill(g, i, j, 0.1, 1, 'rgba(20,10,40,0.1)'); }
      if (wS) rectFill(g, i, j + 0.88, 1, 0.12, 'rgba(20,10,40,0.08)');
      if (wE) rectFill(g, i + 0.88, j, 0.12, 1, 'rgba(20,10,40,0.08)');
    }
    // weiche Schatten unter Möbeln
    const objs = [];
    for (const d of m.devices) { const dt = deviceType(d.type); if (!(dt && dt.mobile) && d.type !== 'saugroboter') objs.push(d); }
    for (const h of m.hides) objs.push(h);
    for (const d of m.decor) if (d.type !== 'wasser') objs.push(d);
    for (const o of objs) {
      g.fillStyle = 'rgba(20,10,40,0.13)';
      g.beginPath(); g.ellipse(o.x + 0.62, o.y + 0.58, 0.55, 0.5, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(20,10,40,0.12)';
      g.beginPath(); g.ellipse(o.x + 0.55, o.y + 0.55, 0.42, 0.42, 0, 0, TAU); g.fill();
    }
  }

  function drawExitMat(g) {
    const ei = R.exitInner;
    if (!ei) return;
    const x = ei.x, y = ei.y;
    rectFill(g, x + 0.12, y + 0.12, 0.76, 0.76, '#5d4037');
    for (let k = 0; k < 5; k++) rectFill(g, x + 0.18, y + 0.2 + k * 0.13, 0.64, 0.06, '#795548');
    g.lineWidth = 0.04; g.strokeStyle = '#3e2723'; g.strokeRect(x + 0.12, y + 0.12, 0.76, 0.76);
  }

  function drawRoomLabels(g) {
    const m = R.map;
    for (const room of m.rooms) {
      const name = String(room.name || '').toUpperCase();
      if (!name || room.w < 3 || room.h < 3) continue;
      const st = roomStyle(room);
      const [r, gg, bb] = rgb(st.floor);
      const light = (r * 0.3 + gg * 0.59 + bb * 0.11) > 140;
      g.save();
      g.translate(room.x + room.w / 2, room.y + room.h / 2);
      g.font = '700 20px ' + FONT;
      const mw = g.measureText(name).width || 1;
      const fs = Math.min(0.62, (room.w * 0.82) / (mw / 20));
      g.scale(fs / 20, fs / 20);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = light ? 'rgba(40,30,70,0.13)' : 'rgba(255,255,255,0.16)';
      g.fillText(name, 0, 0);
      g.restore();
    }
  }

  // ---------------------------------------------------------------------
  //  Helle Raummenge (Fog of War)
  // ---------------------------------------------------------------------
  function computeBright(view) {
    const m = R.map;
    if (!m) return;
    if (view.fog === false || view.spectator) {
      if (R.brightKey !== 'all') { R.bright = new Set(m.rooms.map(r => r.id)); R.brightKey = 'all'; }
      return;
    }
    if (!R.haveMe) {
      if (!R.brightKey) { R.bright = new Set(m.rooms.map(r => r.id)); R.brightKey = 'all'; }
      return;
    }
    const i = Math.floor(R.meX), j = Math.floor(R.meY);
    const t = tileAt(i, j);
    let ids = null;
    if (t === T_FLOOR) { const r = roomAt(i, j); if (r >= 0) ids = [r]; }
    else if (t === T_DOOR) { const d = R.doorAt.get(j * m.w + i); if (d) ids = [d.a, d.b]; }
    if (!ids) return;
    const key = ids.join(',');
    if (key !== R.brightKey) { R.bright = new Set(ids); R.brightKey = key; }
  }
  function isBright(rooms) {
    if (!rooms || !rooms.length) return true;
    for (const r of rooms) if (R.bright.has(r)) return true;
    return false;
  }

  // =====================================================================
  //  Statische Objekte: Wände, Türpfosten, Ausgang, Geräte, Verstecke, Deko
  // =====================================================================

  const DEV_ICON = {
    kaffeeautomat: '☕', snackautomat: '🍫', wc: '🚽', waschbecken: '🚰', kopierer: '🖨️', aktenvernichter: '🗂️',
    buerostuhl: '🪑', chefsessel: '💺', beamer: '📽️', saugroboter: '🤖', aktenschrank: '🗄️', verbandswagen: '🩹',
    krankenbett: '🛏️', roentgen: '🩻', desinfektion: '🧴', wartestuhl: '🪑', medikamentenschrank: '💊',
    nummernautomat: '🎫', heimkino: '🎬', rollladen: '🪟', whirlpool: '🛁', grill: '🍖', poolabdeckung: '🏊',
    sofa: '🛋️', kuehlschrank: '🧊', kommode: '🧺', farbmischer: '🎨', gartenschlauch: '💦', hochregal: '📦',
    kasse: '🧾', paketautomat: '📮', musterkueche: '🍳', werkbank: '🔧'
  };
  // Höhe (für Plaketten & Hit-Test)
  const DEV_H = {
    kaffeeautomat: 1.12, snackautomat: 1.45, wc: 0.82, waschbecken: 1.45, kopierer: 0.98, aktenvernichter: 0.8,
    buerostuhl: 1.0, chefsessel: 1.25, beamer: 1.3, saugroboter: 0.2, aktenschrank: 1.3, verbandswagen: 1.05,
    krankenbett: 0.85, roentgen: 1.5, desinfektion: 1.25, wartestuhl: 0.85, medikamentenschrank: 1.35,
    nummernautomat: 1.25, heimkino: 1.15, rollladen: 1.55, whirlpool: 0.5, grill: 1.15, poolabdeckung: 0.62,
    sofa: 0.8, kuehlschrank: 1.55, kommode: 1.05, farbmischer: 1.25, gartenschlauch: 0.95, hochregal: 1.65,
    kasse: 0.95, paketautomat: 1.55, musterkueche: 1.45, werkbank: 1.4
  };
  const HIDE_H = { spind: 1.3, schreibtisch: 0.86, vorhang: 1.45, karton: 0.78 };
  const DECOR_H = { pflanze: 0.95, tisch: 0.6, regal: 1.35, kiste: 0.55, sonnenschirm: 1.65, liege: 0.45, wasserspender: 1.15, tresen: 0.75, palme: 1.8, sofa_deko: 0.8, lampe: 1.5 };

  function devIcon(type) { const d = deviceType(type); return (d && d.icon) || DEV_ICON[type] || '⚙️'; }
  function devHeight(type) { return DEV_H[type] || ((deviceType(type) && deviceType(type).h) || 1); }

  // ---------- Wand ----------
  function drawWall(o) {
    const b = bld();
    const x0 = o.i, y0 = o.j, x1 = x0 + 1, y1 = y0 + 1, h = o.h;
    if (o.hedge) {
      const g1 = '#3f9a45';
      if (o.f2) quad(x0, y1, 0, x1, y1, 0, x1, y1, h, x0, y1, h, sh(g1, -0.08), false);
      if (o.f4) quad(x1, y0, 0, x1, y1, 0, x1, y1, h, x1, y0, h, sh(g1, -0.3), false);
      quad(x0, y0, h, x1, y0, h, x1, y1, h, x0, y1, h, sh(g1, 0.05), false);
      // Blätterbüschel
      for (let k = 0; k < 3; k++) {
        const u = hash(o.i, o.j, k), v = hash(o.j, o.i, k + 7);
        blob(x0 + 0.2 + u * 0.6, y0 + 0.2 + v * 0.6, h + 0.05, 7 + u * 4, k % 2 ? '#4caf50' : '#43a047', false);
      }
      if (o.f2) for (let k = 0; k < 3; k++) blob(x0 + 0.2 + k * 0.3, y1, h * 0.55, 5, '#388e3c', false);
      return;
    }
    const wc = b.wall, top = b.wallTop;
    const base = sh(top, -0.15), wains = sh(wc, -0.1);
    if (o.f2) {
      quad(x0, y1, 0, x1, y1, 0, x1, y1, h, x0, y1, h, sh(wc, -0.03), false);
      if (h > 0.3) quad(x0, y1, 0.07, x1, y1, 0.07, x1, y1, h * 0.42, x0, y1, h * 0.42, wains, false);
      quad(x0, y1, 0, x1, y1, 0, x1, y1, 0.07, x0, y1, 0.07, base, false);
    }
    if (o.f4) {
      quad(x1, y0, 0, x1, y1, 0, x1, y1, h, x1, y0, h, sh(wc, -0.22), false);
      if (h > 0.3) quad(x1, y0, 0.07, x1, y1, 0.07, x1, y1, h * 0.42, x1, y0, h * 0.42, sh(wc, -0.3), false);
      quad(x1, y0, 0, x1, y1, 0, x1, y1, 0.07, x1, y0, 0.07, sh(top, -0.3), false);
    }
    quad(x0, y0, h, x1, y0, h, x1, y1, h, x0, y1, h, sh(top, 0), false);
    // Kanten nur außen
    C.beginPath();
    const wN = isWallish(tileAt(o.i, o.j - 1)), wW = isWallish(tileAt(o.i - 1, o.j));
    if (!wN) { mv(x0, y0, h); ln(x1, y0, h); }
    if (!wW) { mv(x0, y0, h); ln(x0, y1, h); }
    if (o.f2) { mv(x0, y1, h); ln(x1, y1, h); mv(x0, y1, 0); ln(x1, y1, 0); if (!wW) { mv(x0, y1, 0); ln(x0, y1, h); } }
    if (o.f4) { mv(x1, y0, h); ln(x1, y1, h); mv(x1, y0, 0); ln(x1, y1, 0); if (!wN) { mv(x1, y0, 0); ln(x1, y0, h); } }
    if (o.f2 && o.f4) { mv(x1, y1, 0); ln(x1, y1, h); }
    C.lineWidth = 1; C.strokeStyle = DIM ? 'rgba(10,12,30,0.5)' : 'rgba(30,22,52,0.45)'; C.stroke();
    // Lichtkante oben
    if (!DIM) {
      C.beginPath();
      if (o.f2) { mv(x0, y1, h); ln(x1, y1, h); }
      if (o.f4) { mv(x1, y0, h); ln(x1, y1, h); }
      C.lineWidth = 1.2; C.strokeStyle = 'rgba(255,255,255,0.25)'; C.stroke();
    }
  }

  function drawPost(o) {
    const b = bld();
    const h = (o.wall ? o.wall.h : WALL_H) + 0.12;
    const col = mix(b.wallTop, '#ffffff', 0.25);
    if (o.ax === 'x') box(o.x - 0.08, o.y - 0.5, o.x + 0.08, o.y + 0.5, 0, h, col);
    else box(o.x - 0.5, o.y - 0.08, o.x + 0.5, o.y + 0.08, 0, h, col);
  }

  function drawExit(o, open, t) {
    const x0 = o.i, y0 = o.j, x1 = x0 + 1, y1 = y0 + 1;
    const b = bld();
    const h = 1.05;
    const fy = (o.dir === 'n' || o.dir === 's');
    box(x0, y0, x1, y1, 0, h, b.wall, 7, b.wallTop);
    const dc = open ? '#2ecc71' : '#e74c3c';
    const glow = open ? 0.25 + 0.15 * Math.sin(t * 4) : 0;
    if (fy) {
      quad(x0 + 0.14, y1, 0.02, x1 - 0.14, y1, 0.02, x1 - 0.14, y1, 0.9, x0 + 0.14, y1, 0.9, sh(dc, glow));
      quad(x0 + 0.24, y1, 0.5, x1 - 0.24, y1, 0.5, x1 - 0.24, y1, 0.8, x0 + 0.24, y1, 0.8, sh('#c8f2ff', 0));
      quad(x1 - 0.32, y1, 0.38, x1 - 0.22, y1, 0.38, x1 - 0.22, y1, 0.44, x1 - 0.32, y1, 0.44, sh('#ffd54f', 0));
    } else {
      quad(x1, y0 + 0.14, 0.02, x1, y1 - 0.14, 0.02, x1, y1 - 0.14, 0.9, x1, y0 + 0.14, 0.9, sh(dc, glow - 0.1));
      quad(x1, y0 + 0.24, 0.5, x1, y1 - 0.24, 0.5, x1, y1 - 0.24, 0.8, x1, y0 + 0.24, 0.8, sh('#c8f2ff', -0.1));
      quad(x1, y0 + 0.22, 0.38, x1, y0 + 0.32, 0.38, x1, y0 + 0.32, 0.44, x1, y0 + 0.22, 0.44, sh('#ffd54f', 0));
    }
    // Schild-Kasten oben
    box(x0 + 0.2, y0 + 0.2, x1 - 0.2, y1 - 0.2, h, h + 0.22, open ? '#1faa59' : '#c0392b');
  }

  // ---------- Geräte ----------
  const SNACK_COLS = ['#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#ff6e40', '#e040fb', '#ffab40', '#b2ff59'];
  const DEV = {
    kaffeeautomat(t) {
      lbox(0.16, 0.2, 0.84, 0.86, 0, 1.0, '#3a4350');
      lfront(0.16, 0.84, 0.84, 0.99, 0.2, sh('#e53935', 0));
      lfront(0.26, 0.74, 0.58, 0.79, 0.2, sh('#0f1c26', 0));
      lfront(0.29, 0.71, 0.61, 0.76, 0.2, sh('#53e6ff', 0.1 * Math.sin(t * 2)), false);
      lfront(0.33, 0.55, 0.66, 0.69, 0.2, sh('#ffffff', 0), false);
      lfront(0.33, 0.48, 0.71, 0.73, 0.2, sh('#ffffff', 0), false);
      lcirc(0.33, 0.5, 0.035, 0.2, sh('#ffd54f', 0));
      lcirc(0.5, 0.5, 0.035, 0.2, sh('#81c784', 0));
      lcirc(0.67, 0.5, 0.035, 0.2, sh('#ff8a65', 0));
      lfront(0.32, 0.68, 0.06, 0.42, 0.2, sh('#141a20', 0));
      lfront(0.32, 0.68, 0.06, 0.1, 0.2, sh('#6b7b8c', 0), false);
      lcyl(0.5, 0.12, 0.1, 0.07, 0.13, '#ffffff', '#6d4c41');
      lcyl(0.5, 0.55, 1.0, 0.17, 0.13, '#d9e2e7', '#6d4c41');
      if (!DIM) {
        for (let k = 0; k < 3; k++) {
          const ph = (t * 0.55 + k / 3) % 1;
          const [px, py] = lpt(0.5 + Math.sin(ph * 6 + k) * 0.04, 0.12, 0.3 + ph * 0.45);
          C.beginPath(); C.arc(px, py, 2 + ph * 3, 0, TAU);
          C.fillStyle = 'rgba(255,255,255,' + (0.45 * (1 - ph)) + ')'; C.fill();
        }
      }
    },
    snackautomat(t) {
      lbox(0.12, 0.2, 0.88, 0.88, 0, 1.45, '#7b1fa2');
      lfront(0.12, 0.88, 1.3, 1.44, 0.2, sh('#ffeb3b', 0.05 * Math.sin(t * 3)));
      lfront(0.17, 0.66, 0.3, 1.25, 0.2, sh('#14202e', 0));
      for (let r = 0; r < 4; r++) {
        const z = 0.38 + r * 0.22;
        lfront(0.18, 0.65, z - 0.02, z - 0.005, 0.2, sh('#9aa7b4', 0), false);
        for (let c = 0; c < 4; c++) {
          const u = 0.2 + c * 0.112;
          lfront(u, u + 0.085, z, z + 0.13, 0.2, sh(SNACK_COLS[(r * 3 + c) % 8], 0), false);
          lfront(u + 0.01, u + 0.04, z + 0.02, z + 0.11, 0.2, 'rgba(255,255,255,0.35)', false);
        }
      }
      lfront(0.19, 0.27, 0.32, 1.22, 0.2, DIM ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.13)', false);
      lfront(0.69, 0.84, 0.55, 1.22, 0.2, sh('#4a148c', 0));
      for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) lcirc(0.735 + c * 0.065, 1.08 - r * 0.09, 0.022, 0.2, sh('#e1bee7', 0), false);
      lfront(0.72, 0.81, 0.68, 0.74, 0.2, sh('#111111', 0));
      lfront(0.2, 0.64, 0.07, 0.24, 0.2, sh('#101010', 0));
    },
    wc(t) {
      lbox(0.24, 0.66, 0.76, 0.94, 0.3, 0.85, '#f4f6f9');
      ltop(0.42, 0.74, 0.58, 0.86, 0.855, sh('#b0bec5', 0));
      lcyl(0.5, 0.45, 0, 0.15, 0.3, '#eef2f6');
      lfront(0.26, 0.74, 0.36, 0.8, 0.66, sh('#e9eef3', 0));
      lell(0.5, 0.42, 0.34, 0.26, sh('#ffffff', 0), true);
      lell(0.5, 0.43, 0.345, 0.17, sh('#a9dcf7', 0), false);
      lell(0.5, 0.43, 0.346, 0.09, sh('#7fc6f0', 0), false);
    },
    waschbecken(t) {
      lfront(0.22, 0.78, 0.92, 1.45, 0.96, sh('#90a4ae', 0));
      lfront(0.25, 0.75, 0.95, 1.42, 0.96, sh('#cdeeff', 0), false);
      lfront(0.3, 0.38, 1.05, 1.35, 0.96, DIM ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.55)', false);
      lbox(0.2, 0.34, 0.8, 0.9, 0, 0.6, '#8fa3b0');
      lfront(0.23, 0.49, 0.06, 0.55, 0.34, sh('#a9bcc8', 0));
      lfront(0.51, 0.77, 0.06, 0.55, 0.34, sh('#a9bcc8', 0));
      lfront(0.43, 0.46, 0.3, 0.4, 0.34, sh('#556270', 0), false);
      lfront(0.54, 0.57, 0.3, 0.4, 0.34, sh('#556270', 0), false);
      lbox(0.16, 0.3, 0.84, 0.92, 0.6, 0.67, '#f7f7f7');
      lell(0.5, 0.58, 0.675, 0.2, sh('#d8e2e8', 0), true);
      lell(0.5, 0.58, 0.68, 0.13, sh('#7cc8f5', 0.1 * Math.sin(t * 3)), false);
      lcyl(0.5, 0.84, 0.67, 0.03, 0.15, '#cfd8dc');
      lbox(0.47, 0.68, 0.53, 0.86, 0.8, 0.84, '#cfd8dc');
      lcyl(0.27, 0.8, 0.67, 0.05, 0.12, '#ff80ab', '#ffffff');
    },
    kopierer(t) {
      lbox(0.1, 0.2, 0.9, 0.86, 0, 0.84, '#e7ebee');
      lbox(0.12, 0.22, 0.88, 0.84, 0.84, 0.93, '#aab5bd');
      lfront(0.15, 0.85, 0.12, 0.3, 0.2, sh('#d0d8de', 0));
      lfront(0.15, 0.85, 0.34, 0.52, 0.2, sh('#d0d8de', 0));
      lfront(0.4, 0.6, 0.24, 0.26, 0.2, sh('#4b5862', 0), false);
      lfront(0.4, 0.6, 0.46, 0.48, 0.2, sh('#4b5862', 0), false);
      lfront(0.15, 0.85, 0.6, 0.7, 0.2, sh('#ffffff', 0));
      lbox(0.56, 0.12, 0.88, 0.34, 0.82, 0.97, '#3f515c');
      ltop(0.6, 0.16, 0.84, 0.3, 0.975, sh('#79f2a6', 0.15 * Math.sin(t * 4)), false);
      lcirc(0.2, 0.75, 0.025, 0.2, sh(Math.sin(t * 5) > 0 ? '#4caf50' : '#1b5e20', 0), false);
    },
    aktenvernichter(t) {
      lbox(0.24, 0.3, 0.76, 0.8, 0, 0.74, '#38474f');
      lfront(0.3, 0.7, 0.08, 0.46, 0.3, sh('#8ea1ac', 0));
      for (let k = 0; k < 7; k++) lfront(0.33 + k * 0.05, 0.345 + k * 0.05, 0.1, 0.2 + hash(k, 3, 1) * 0.2, 0.3, sh('#ffffff', 0), false);
      ltop(0.3, 0.5, 0.7, 0.6, 0.745, sh('#0e1214', 0), false);
      for (let k = 0; k < 5; k++) lfront(0.36 + k * 0.06, 0.38 + k * 0.06, 0.74, 0.86 + hash(k, 1, 2) * 0.06, 0.55, sh('#ffffff', 0));
      lcirc(0.66, 0.64, 0.025, 0.3, sh((t % 1.2) < 0.6 ? '#ff5252' : '#7f1d1d', 0), false);
    },
    buerostuhl(t) {
      chairBase('#263238');
      lbox(0.28, 0.72, 0.72, 0.8, 0.46, 1.0, '#1e88e5');
      lbox(0.26, 0.26, 0.74, 0.72, 0.36, 0.46, '#1e88e5');
      lbox(0.21, 0.34, 0.27, 0.66, 0.46, 0.56, '#263238');
      lbox(0.73, 0.34, 0.79, 0.66, 0.46, 0.56, '#263238');
    },
    chefsessel(t) {
      chairBase('#1b1b1b');
      lbox(0.2, 0.72, 0.8, 0.84, 0.42, 1.25, '#5d4037');
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) lcirc(0.32 + c * 0.18, 0.62 + r * 0.2, 0.018, 0.72, sh('#3e2723', 0), false);
      lbox(0.2, 0.22, 0.8, 0.74, 0.34, 0.48, '#6d4c41');
      lbox(0.14, 0.28, 0.24, 0.74, 0.42, 0.66, '#4e342e');
      lbox(0.76, 0.28, 0.86, 0.74, 0.42, 0.66, '#4e342e');
    },
    beamer(t) {
      lfront(0.06, 0.94, 0.62, 1.32, 0.97, sh('#fafafa', 0));
      lfront(0.06, 0.94, 1.28, 1.34, 0.97, sh('#37474f', 0));
      const bars = [0.25, 0.42, 0.33, 0.55];
      for (let k = 0; k < 4; k++) lfront(0.2 + k * 0.16, 0.3 + k * 0.16, 0.72, 0.72 + bars[k], 0.97, sh(['#42a5f5', '#66bb6a', '#ffca28', '#ef5350'][k], 0), false);
      tableLegs(0.18, 0.22, 0.82, 0.82, 0.48, '#6d4c41');
      lbox(0.15, 0.2, 0.85, 0.85, 0.48, 0.54, '#8d6e63');
      lbox(0.3, 0.32, 0.7, 0.68, 0.54, 0.72, '#eceff1');
      lcirc(0.4, 0.63, 0.065, 0.32, sh('#263238', 0));
      lcirc(0.4, 0.63, 0.035, 0.32, sh('#80d8ff', 0.2 * Math.sin(t * 6)), false);
      lcirc(0.6, 0.66, 0.02, 0.32, sh('#69f0ae', 0), false);
    },
    aktenschrank(t) {
      lbox(0.18, 0.3, 0.82, 0.86, 0, 1.3, '#9aa6b2');
      for (let k = 0; k < 4; k++) {
        const z0 = 0.06 + k * 0.31;
        lfront(0.22, 0.78, z0, z0 + 0.27, 0.3, sh('#b4bfca', 0));
        lfront(0.42, 0.58, z0 + 0.16, z0 + 0.2, 0.3, sh('#566370', 0), false);
        lfront(0.44, 0.56, z0 + 0.06, z0 + 0.12, 0.3, sh('#fff8e1', 0), false);
      }
    },
    verbandswagen(t) {
      for (const [u, v] of [[0.2, 0.75], [0.8, 0.75], [0.2, 0.28], [0.8, 0.28]]) lcyl(u, v, 0.06, 0.025, 0.86, '#b0bec5');
      for (const z of [0.12, 0.48, 0.84]) lbox(0.14, 0.24, 0.86, 0.8, z, z + 0.05, '#dfe6ea');
      lbox(0.2, 0.32, 0.45, 0.7, 0.17, 0.36, '#4fc3f7');
      lbox(0.52, 0.32, 0.8, 0.7, 0.17, 0.3, '#aed581');
      lbox(0.2, 0.32, 0.5, 0.72, 0.53, 0.68, '#ffffff');
      lfront(0.3, 0.4, 0.57, 0.64, 0.32, sh('#e53935', 0), false);
      lfront(0.33, 0.37, 0.55, 0.66, 0.32, sh('#e53935', 0), false);
      lcyl(0.66, 0.5, 0.53, 0.1, 0.13, '#ffffff', '#f5f5f5');
      lcyl(0.42, 0.5, 0.89, 0.09, 0.16, '#fafafa');
      lcyl(0.66, 0.5, 0.89, 0.09, 0.16, '#fafafa');
      lfront(0.14, 0.86, 0.89, 0.94, 0.24, sh('#e53935', 0));
      for (const [u, v] of [[0.2, 0.28], [0.8, 0.28], [0.2, 0.75], [0.8, 0.75]]) lblob(u, v, 0.05, 3.2, '#37474f');
    },
    krankenbett(t) {
      for (const [u, v] of [[0.14, 0.86], [0.86, 0.86], [0.14, 0.12], [0.86, 0.12]]) { lcyl(u, v, 0.08, 0.02, 0.16, '#90a4ae'); lblob(u, v, 0.05, 3, '#37474f'); }
      lbox(0.08, 0.9, 0.92, 0.98, 0.15, 0.85, '#90a4ae');
      lbox(0.1, 0.06, 0.9, 0.92, 0.22, 0.34, '#b0bec5');
      lbox(0.13, 0.08, 0.87, 0.9, 0.34, 0.47, '#ffffff');
      lbox(0.13, 0.08, 0.87, 0.58, 0.47, 0.51, '#64b5f6');
      lfront(0.13, 0.87, 0.47, 0.51, 0.58, sh('#e3f2fd', 0), false);
      lbox(0.22, 0.66, 0.78, 0.86, 0.47, 0.57, '#f7f7f7');
      lbox(0.08, 0.06, 0.92, 0.12, 0.2, 0.42, '#90a4ae');
      lcyl(0.95, 0.5, 0.0, 0.02, 1.25, '#b0bec5');
      lbox(0.88, 0.42, 0.98, 0.58, 1.1, 1.3, '#e1f5fe');
    },
    roentgen(t) {
      lfront(0.12, 0.88, 0.55, 1.25, 0.97, sh('#d6ecff', 0.1 + 0.05 * Math.sin(t * 2)));
      if (!DIM) {
        C.save(); C.globalAlpha *= 0.9;
        for (let k = 0; k < 4; k++) lfront(0.3, 0.7, 0.75 + k * 0.1, 0.78 + k * 0.1, 0.97, '#ffffff', false);
        lfront(0.48, 0.52, 0.65, 1.15, 0.97, '#ffffff', false);
        lcirc(0.5, 1.18, 0.06, 0.97, '#ffffff', false);
        C.restore();
      }
      lbox(0.15, 0.2, 0.85, 0.85, 0, 0.36, '#eceff1');
      lbox(0.42, 0.72, 0.58, 0.86, 0.36, 1.48, '#cfd8dc');
      lbox(0.3, 0.32, 0.7, 0.86, 1.38, 1.48, '#cfd8dc');
      lbox(0.32, 0.3, 0.68, 0.58, 1.12, 1.38, '#fafafa');
      lfront(0.38, 0.62, 1.16, 1.3, 0.3, sh('#ffca28', 0));
      lcirc(0.5, 1.23, 0.04, 0.3, sh('#212121', 0), false);
      lfront(0.22, 0.78, 0.08, 0.3, 0.2, sh('#263238', 0));
      lfront(0.26, 0.6, 0.13, 0.25, 0.2, sh('#4dd0e1', 0.2 * Math.sin(t * 3)), false);
    },
    desinfektion(t) {
      lell(0.5, 0.5, 0.0, 0.2, sh('#90a4ae', 0), true);
      lcyl(0.5, 0.5, 0, 0.035, 1.0, '#b0bec5');
      lbox(0.4, 0.36, 0.6, 0.56, 0.6, 0.63, '#90a4ae');
      lbox(0.34, 0.38, 0.66, 0.62, 0.84, 1.22, '#ffffff');
      lfront(0.39, 0.61, 0.92, 1.1, 0.38, sh('#4fc3f7', 0.1 * Math.sin(t * 2)));
      lfront(0.46, 0.54, 1.12, 1.19, 0.38, sh('#43a047', 0), false);
      lfront(0.48, 0.52, 0.8, 0.86, 0.38, sh('#78909c', 0), false);
    },
    wartestuhl(t) {
      lbox(0.06, 0.4, 0.94, 0.5, 0.1, 0.16, '#78909c');
      for (const u of [0.12, 0.88]) lbox(u - 0.03, 0.42, u + 0.03, 0.48, 0, 0.36, '#78909c');
      lbox(0.08, 0.72, 0.48, 0.8, 0.42, 0.85, '#ff7043');
      lbox(0.52, 0.72, 0.92, 0.8, 0.42, 0.85, '#29b6f6');
      lbox(0.08, 0.28, 0.48, 0.74, 0.34, 0.42, '#ff7043');
      lbox(0.52, 0.28, 0.92, 0.74, 0.34, 0.42, '#29b6f6');
    },
    medikamentenschrank(t) {
      for (const u of [0.2, 0.8]) lbox(u - 0.03, 0.34, u + 0.03, 0.4, 0, 0.3, '#90a4ae');
      lbox(0.14, 0.3, 0.86, 0.86, 0.3, 1.35, '#f4f7f8');
      lfront(0.18, 0.49, 0.36, 1.2, 0.3, sh('#d4eefc', 0));
      lfront(0.51, 0.82, 0.36, 1.2, 0.3, sh('#d4eefc', 0));
      for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) {
        const u = 0.21 + c * 0.12, z = 0.42 + r * 0.26;
        lfront(u, u + 0.06, z, z + 0.14, 0.31, sh(['#ef5350', '#ffca28', '#66bb6a', '#ab47bc', '#29b6f6'][(r + c) % 5], 0.2), false);
      }
      lfront(0.44, 0.56, 1.25, 1.29, 0.3, sh('#43a047', 0), false);
      lfront(0.48, 0.52, 1.21, 1.33, 0.3, sh('#43a047', 0), false);
    },
    nummernautomat(t) {
      lell(0.5, 0.5, 0, 0.18, sh('#90a4ae', 0), true);
      lcyl(0.5, 0.5, 0, 0.045, 0.78, '#b0bec5');
      lbox(0.3, 0.38, 0.7, 0.64, 0.74, 1.24, '#e53935');
      lfront(0.35, 0.65, 1.0, 1.17, 0.38, sh('#1a1a1a', 0));
      for (let k = 0; k < 3; k++) lfront(0.38 + k * 0.09, 0.45 + k * 0.09, 1.03, 1.14, 0.38, sh('#ff9100', 0.1 * Math.sin(t * 3 + k)), false);
      lfront(0.39, 0.61, 0.85, 0.89, 0.38, sh('#222222', 0), false);
      lfront(0.42, 0.58, 0.77, 0.87, 0.37, sh('#ffffff', 0));
    },
    heimkino(t) {
      lbox(0.02, 0.62, 0.14, 0.78, 0, 0.98, '#212121');
      lbox(0.86, 0.62, 0.98, 0.78, 0, 0.98, '#212121');
      lcirc(0.08, 0.3, 0.04, 0.62, sh('#424242', 0), false);
      lcirc(0.92, 0.3, 0.04, 0.62, sh('#424242', 0), false);
      lbox(0.16, 0.55, 0.84, 0.92, 0, 0.32, '#4e342e');
      lbox(0.45, 0.8, 0.55, 0.86, 0.32, 0.44, '#212121');
      lbox(0.12, 0.84, 0.88, 0.9, 0.42, 1.12, '#121212');
      const hue = (t * 20) % 360;
      lfront(0.15, 0.85, 0.45, 1.09, 0.84, DIM ? sh('#1a237e', 0) : 'hsl(' + (200 + Math.sin(t * 0.4) * 30) + ',70%,55%)', false);
      if (!DIM) {
        lfront(0.15, 0.85, 0.45, 0.62, 0.84, 'hsl(' + (110 + Math.sin(t * 0.3) * 20) + ',55%,45%)', false);
        lcirc(0.66, 0.92, 0.07, 0.84, 'hsl(' + (45 + hue * 0.02) + ',95%,62%)', false);
        lfront(0.28, 0.36, 0.62, 0.78, 0.84, '#3e2723', false);
        lcirc(0.32, 0.82, 0.07, 0.84, '#2e7d32', false);
      }
    },
    rollladen(t) {
      lbox(0.06, 0.82, 0.94, 0.98, 0.15, 1.42, '#eef2f4');
      lfront(0.13, 0.87, 0.22, 1.36, 0.82, sh('#9fd8ff', 0));
      lfront(0.13, 0.87, 0.22, 0.5, 0.82, sh('#c5ecff', 0), false);
      lfront(0.49, 0.51, 0.22, 1.36, 0.82, sh('#eef2f4', 0), false);
      const down = 0.62 + 0.08 * Math.sin(t * 0.5);
      for (let z = 1.36; z > down; z -= 0.065) lfront(0.13, 0.87, Math.max(down, z - 0.06), z, 0.81, sh(((z * 100) | 0) % 2 ? '#b0bec5' : '#cfd8dc', 0), false);
      lbox(0.04, 0.78, 0.96, 0.99, 1.42, 1.56, '#cfd8dc');
      lbox(0.04, 0.72, 0.96, 0.86, 0.15, 0.2, '#ffffff');
      lfront(0.89, 0.95, 0.6, 0.76, 0.8, sh('#263238', 0));
      lcirc(0.92, 0.7, 0.016, 0.79, sh('#00e676', 0.2 * Math.sin(t * 4)), false);
    },
    whirlpool(t) {
      lcyl(0.5, 0.5, 0, 0.45, 0.42, '#f5f7fa');
      lell(0.5, 0.5, 0.42, 0.37, sh('#26c6da', 0.1 * Math.sin(t * 2)), true);
      lell(0.5, 0.5, 0.425, 0.28, sh('#4dd0e1', 0.1 * Math.sin(t * 3)), false);
      if (!DIM) {
        for (let k = 0; k < 9; k++) {
          const a = k * 0.7 + t * 0.6, rr2 = 0.08 + hash(k, 2, 2) * 0.24;
          const ph = (t * 1.3 + hash(k, 5, 5)) % 1;
          L(0.5 + Math.cos(a) * rr2, 0.5 + Math.sin(a) * rr2);
          const px = (WX - WY) * HW, py = (WX + WY) * HH - 0.43 * ZH - ph * 5;
          C.beginPath(); C.arc(px, py, 1.5 + ph * 2.5, 0, TAU);
          C.strokeStyle = 'rgba(255,255,255,' + (0.8 * (1 - ph)) + ')'; C.lineWidth = 1; C.stroke();
        }
      }
      lbox(0.3, 0.0, 0.7, 0.08, 0, 0.18, '#e0e6ea');
    },
    grill(t) {
      for (const [u, v] of [[0.2, 0.35], [0.8, 0.35], [0.2, 0.75], [0.8, 0.75]]) lbox(u - 0.025, v - 0.025, u + 0.025, v + 0.025, 0, 0.45, '#37474f');
      lbox(0.02, 0.32, 0.16, 0.78, 0.6, 0.64, '#8d6e63');
      lbox(0.84, 0.32, 0.98, 0.78, 0.6, 0.64, '#8d6e63');
      lfront(0.16, 0.84, 0.75, 1.15, 0.84, sh('#a31515', 0));
      lbox(0.16, 0.3, 0.84, 0.8, 0.42, 0.74, '#c62828');
      ltop(0.19, 0.33, 0.81, 0.77, 0.745, sh('#3a1f1a', 0), false);
      if (!DIM) ltop(0.22, 0.36, 0.78, 0.74, 0.746, 'rgba(255,120,30,' + (0.35 + 0.15 * Math.sin(t * 7)) + ')', false);
      for (let k = 0; k < 6; k++) lline(0.2 + k * 0.12, 0.34, 0.75, 0.2 + k * 0.12, 0.76, 0.75, sh('#757575', 0), 1);
      for (let k = 0; k < 3; k++) lbox(0.28 + k * 0.17, 0.42, 0.37 + k * 0.17, 0.66, 0.75, 0.8, '#a1442a');
      lfront(0.35, 0.65, 0.5, 0.56, 0.3, sh('#eeeeee', 0), false);
      if (!DIM) {
        for (let k = 0; k < 4; k++) {
          const ph = (t * 0.4 + k / 4) % 1;
          const [px, py] = lpt(0.5 + Math.sin(ph * 5 + k) * 0.1, 0.55, 0.85 + ph * 0.9);
          C.beginPath(); C.arc(px, py, 3 + ph * 7, 0, TAU);
          C.fillStyle = 'rgba(200,200,210,' + (0.4 * (1 - ph)) + ')'; C.fill();
        }
      }
    },
    poolabdeckung(t) {
      lbox(0.04, 0.32, 0.14, 0.68, 0, 0.55, '#90a4ae');
      lbox(0.86, 0.32, 0.96, 0.68, 0, 0.55, '#90a4ae');
      lbox(0.12, 0.34, 0.88, 0.66, 0.26, 0.58, '#1e88e5');
      for (let k = 0; k < 5; k++) lfront(0.12, 0.88, 0.3 + k * 0.06, 0.32 + k * 0.06, 0.34, sh(k % 2 ? '#64b5f6' : '#bbdefb', 0), false);
      lbox(0.0, 0.46, 0.06, 0.54, 0.4, 0.44, '#546e7a');
      lbox(-0.02, 0.46, 0.02, 0.54, 0.25, 0.44, '#546e7a');
    },
    sofa(t) { drawSofa('#5c6bc0', '#ffca28', '#ef5350'); },
    kuehlschrank(t) {
      lbox(0.14, 0.24, 0.86, 0.88, 0, 1.55, '#e3e9ed');
      lfront(0.14, 0.86, 1.0, 1.03, 0.24, sh('#93a1aa', 0), false);
      lfront(0.74, 0.79, 1.1, 1.46, 0.24, sh('#78909c', 0));
      lfront(0.74, 0.79, 0.45, 0.92, 0.24, sh('#78909c', 0));
      lfront(0.26, 0.5, 1.26, 1.42, 0.24, sh('#0e1a22', 0));
      lfront(0.28, 0.48, 1.28, 1.4, 0.24, sh('#26c6da', 0.15 * Math.sin(t * 2)), false);
      lcirc(0.3, 0.8, 0.03, 0.24, sh('#ff5252', 0), false);
      lcirc(0.42, 0.7, 0.03, 0.24, sh('#ffd740', 0), false);
      lfront(0.35, 0.5, 0.55, 0.75, 0.24, sh('#fff9c4', 0));
    },
    kommode(t) {
      lbox(0.1, 0.3, 0.9, 0.86, 0, 0.78, '#a1887f');
      for (let k = 0; k < 3; k++) {
        const z0 = 0.05 + k * 0.24;
        lfront(0.14, 0.86, z0, z0 + 0.2, 0.3, sh('#bcaaa4', 0));
        lcirc(0.38, z0 + 0.1, 0.022, 0.3, sh('#5d4037', 0), false);
        lcirc(0.62, z0 + 0.1, 0.022, 0.3, sh('#5d4037', 0), false);
      }
      lcyl(0.7, 0.58, 0.78, 0.06, 0.18, '#26a69a');
      for (let k = 0; k < 3; k++) lblob(0.67 + k * 0.03, 0.58, 1.0 + (k % 2) * 0.05, 3.5, ['#ff4081', '#ffeb3b', '#e040fb'][k], false);
      lcyl(0.3, 0.6, 0.78, 0.04, 0.18, '#424242');
      lcyl(0.3, 0.6, 0.94, 0.12, 0.1, '#fff3c4', '#ffe082');
    },
    farbmischer(t) {
      lbox(0.14, 0.42, 0.86, 0.92, 0, 1.22, '#eceff1');
      const cols = ['#00bcd4', '#e91e63', '#ffeb3b', '#212121', '#ffffff', '#4caf50'];
      for (let k = 0; k < 6; k++) lcyl(0.22 + k * 0.112, 0.67, 1.22, 0.05, 0.12, cols[k]);
      lbox(0.32, 0.3, 0.68, 0.5, 0.82, 0.98, '#78909c');
      lbox(0.24, 0.08, 0.76, 0.44, 0.1, 0.18, '#546e7a');
      lcyl(0.5, 0.26, 0.18, 0.13, 0.24, '#d8dee2', '#e91e63');
      if (!DIM) {
        const ph = (t * 0.9) % 1;
        const [px, py] = lpt(0.5, 0.3, 0.8 - ph * 0.36);
        C.beginPath(); C.arc(px, py, 2, 0, TAU); C.fillStyle = 'hsl(' + ((t * 60) % 360) + ',85%,55%)'; C.fill();
      }
      for (let k = 0; k < 6; k++) lfront(0.18 + k * 0.11, 0.26 + k * 0.11, 0.3, 0.42, 0.42, sh(['#f44336', '#ff9800', '#ffeb3b', '#4caf50', '#2196f3', '#9c27b0'][k], 0), false);
    },
    gartenschlauch(t) {
      lfront(0.18, 0.82, 0.15, 0.95, 0.94, sh('#2e7d32', 0));
      lcirc(0.5, 0.58, 0.3, 0.9, sh('#1b5e20', 0));
      for (let k = 0; k < 4; k++) {
        C.beginPath();
        for (let i = 0; i <= 20; i++) { const a = (i / 20) * TAU, r = 0.27 - k * 0.055; if (!i) lmv(0.5 + Math.cos(a) * r, 0.86, 0.58 + Math.sin(a) * r); else lln(0.5 + Math.cos(a) * r, 0.86, 0.58 + Math.sin(a) * r); }
        C.lineWidth = 2.6; C.strokeStyle = sh(k % 2 ? '#7cb342' : '#9ccc65', 0); C.stroke();
      }
      lcirc(0.5, 0.58, 0.05, 0.85, sh('#ffeb3b', 0));
      C.beginPath(); lmv(0.5, 0.86, 0.31); C.bezierCurveTo(...lpt(0.45, 0.6, 0.1), ...lpt(0.3, 0.3, 0.0), ...lpt(0.35, 0.15, 0.04));
      C.lineWidth = 3; C.strokeStyle = sh('#7cb342', 0); C.stroke();
      lbox(0.3, 0.1, 0.42, 0.2, 0, 0.08, '#ffeb3b');
      if (!DIM) lell(0.3, 0.12, 0.0, 0.16, 'rgba(100,180,255,0.35)', false);
    },
    hochregal(t) {
      const posts = [[0.06, 0.88], [0.94, 0.88], [0.06, 0.12], [0.94, 0.12]];
      for (let k = 0; k < 2; k++) lbox(posts[k][0] - 0.03, posts[k][1] - 0.03, posts[k][0] + 0.03, posts[k][1] + 0.03, 0, 1.65, '#ff7043');
      const levels = [0.04, 0.58, 1.12];
      for (let li = 0; li < levels.length; li++) {
        const z = levels[li];
        lbox(0.04, 0.1, 0.96, 0.9, z, z + 0.05, '#1e88e5');
        const n = 2 + (li % 2);
        for (let b = 0; b < n; b++) {
          const w = 0.82 / n;
          const u0 = 0.08 + b * w, hgt = 0.26 + hash(li, b, 3) * 0.16;
          lbox(u0 + 0.02, 0.2, u0 + w - 0.02, 0.8, z + 0.05, z + 0.05 + hgt, ['#c8a165', '#d4b07a', '#bf9558'][(li + b) % 3]);
          lfront(u0 + w / 2 - 0.03, u0 + w / 2 + 0.03, z + 0.05, z + 0.05 + hgt, 0.2, sh('#e9d3a8', 0), false);
        }
      }
      lbox(0.04, 0.1, 0.96, 0.9, 1.6, 1.65, '#1e88e5');
      for (let k = 2; k < 4; k++) lbox(posts[k][0] - 0.03, posts[k][1] - 0.03, posts[k][0] + 0.03, posts[k][1] + 0.03, 0, 1.65, '#ff7043');
    },
    kasse(t) {
      lbox(0.04, 0.2, 0.96, 0.86, 0, 0.6, '#455a64');
      lfront(0.04, 0.96, 0.4, 0.5, 0.2, sh('#ff7043', 0), false);
      ltop(0.08, 0.24, 0.92, 0.52, 0.605, sh('#1c1c1c', 0), false);
      for (let k = 0; k < 8; k++) { const u = 0.08 + ((k * 0.11 + t * 0.15) % 0.84); lline(u, 0.25, 0.607, u, 0.51, 0.607, 'rgba(255,255,255,0.12)', 1); }
      ltop(0.56, 0.56, 0.78, 0.76, 0.606, sh('#80deea', 0.2 * Math.sin(t * 5)), false);
      lbox(0.1, 0.6, 0.42, 0.85, 0.6, 0.74, '#eceff1');
      lbox(0.18, 0.66, 0.36, 0.71, 0.74, 0.96, '#263238');
      lfront(0.2, 0.34, 0.78, 0.93, 0.66, sh('#69f0ae', 0), false);
      lcyl(0.9, 0.78, 0.6, 0.022, 0.55, '#90a4ae');
      lbox(0.8, 0.72, 0.98, 0.84, 1.1, 1.28, '#00c853');
    },
    paketautomat(t) {
      lbox(0.04, 0.3, 0.96, 0.92, 0, 1.52, '#ffc107');
      lfront(0.04, 0.96, 1.4, 1.5, 0.3, sh('#d32f2f', 0));
      for (let c = 0; c < 3; c++) for (let r = 0; r < 4; r++) {
        if (c === 1 && (r === 2 || r === 3)) continue;
        const u0 = 0.08 + c * 0.29, z0 = 0.06 + r * 0.33;
        lfront(u0, u0 + 0.26, z0, z0 + 0.3, 0.3, sh('#ffd54f', 0));
        lfront(u0 + 0.19, u0 + 0.22, z0 + 0.12, z0 + 0.18, 0.3, sh('#8d6e00', 0), false);
      }
      lfront(0.39, 0.63, 0.75, 1.3, 0.3, sh('#263238', 0));
      lfront(0.42, 0.6, 1.0, 1.24, 0.3, sh('#4fc3f7', 0.15 * Math.sin(t * 2)), false);
      lfront(0.45, 0.57, 0.8, 0.92, 0.3, sh('#90a4ae', 0), false);
    },
    musterkueche(t) {
      lbox(0.02, 0.76, 0.98, 0.96, 1.0, 1.42, '#26a69a');
      lfront(0.48, 0.5, 1.02, 1.4, 0.76, sh('#1d8076', 0), false);
      lbox(0.02, 0.3, 0.98, 0.9, 0, 0.58, '#fafafa');
      lfront(0.05, 0.48, 0.05, 0.54, 0.3, sh('#26a69a', 0));
      lfront(0.52, 0.95, 0.05, 0.54, 0.3, sh('#26a69a', 0));
      lfront(0.2, 0.33, 0.44, 0.47, 0.3, sh('#e0f2f1', 0), false);
      lfront(0.67, 0.8, 0.44, 0.47, 0.3, sh('#e0f2f1', 0), false);
      lbox(0.0, 0.28, 1.0, 0.92, 0.58, 0.64, '#4e342e');
      ltop(0.1, 0.4, 0.42, 0.8, 0.645, sh('#cfd8dc', 0), false);
      ltop(0.14, 0.44, 0.38, 0.76, 0.646, sh('#90a4ae', 0), false);
      ltop(0.55, 0.4, 0.92, 0.8, 0.645, sh('#212121', 0), false);
      for (const [u, v] of [[0.64, 0.5], [0.83, 0.5], [0.64, 0.7], [0.83, 0.7]]) lell(u, v, 0.647, 0.06, sh('#ff5722', 0.25 * Math.sin(t * 3 + u * 9)), false);
      lcyl(0.26, 0.85, 0.64, 0.02, 0.18, '#b0bec5');
      lbox(0.78, 0.0, 0.94, 0.08, 0.46, 0.66, '#ffeb3b');
      lfront(0.79, 0.93, 0.5, 0.62, 0.0, sh('#d32f2f', 0), false);
    },
    werkbank(t) {
      lfront(0.04, 0.96, 0.65, 1.38, 0.95, sh('#d7b98e', 0));
      for (let r = 0; r < 5; r++) for (let c = 0; c < 9; c++) lcirc(0.1 + c * 0.1, 0.7 + r * 0.14, 0.012, 0.95, sh('#9c7c55', 0), false);
      lfront(0.15, 0.19, 0.8, 1.2, 0.94, sh('#5d4037', 0), false);
      lfront(0.1, 0.24, 1.12, 1.22, 0.94, sh('#616161', 0), false);
      lfront(0.4, 0.43, 0.75, 1.15, 0.94, sh('#e53935', 0), false);
      lfront(0.38, 0.45, 1.15, 1.25, 0.94, sh('#9e9e9e', 0), false);
      lfront(0.6, 0.85, 1.0, 1.06, 0.94, sh('#9e9e9e', 0), false);
      lcirc(0.62, 1.03, 0.05, 0.94, sh('#9e9e9e', 0), false);
      tableLegs(0.08, 0.24, 0.92, 0.82, 0.55, '#6d4c41');
      lbox(0.04, 0.2, 0.96, 0.86, 0.55, 0.64, '#bc8f5a');
      lbox(0.7, 0.18, 0.92, 0.36, 0.64, 0.78, '#607d8b');
      lbox(0.25, 0.45, 0.55, 0.5, 0.64, 0.67, '#ffb300');
      lbox(0.5, 0.42, 0.6, 0.53, 0.64, 0.72, '#757575');
    }
  };

  function chairBase(col) {
    for (let k = 0; k < 5; k++) {
      const a = k * 1.2566 + 0.3;
      lline(0.5, 0.5, 0.07, 0.5 + Math.cos(a) * 0.32, 0.5 + Math.sin(a) * 0.32, 0.05, sh(col, 0), 2.4);
      lblob(0.5 + Math.cos(a) * 0.32, 0.5 + Math.sin(a) * 0.32, 0.03, 2.2, col, false);
    }
    lcyl(0.5, 0.5, 0.06, 0.04, 0.3, '#90a4ae');
  }
  function tableLegs(u0, v0, u1, v1, h, col) {
    for (const [u, v] of [[u0, v1], [u1, v1], [u0, v0], [u1, v0]]) lbox(u - 0.025, v - 0.025, u + 0.025, v + 0.025, 0, h, col);
  }
  function drawSofa(c, c2, c3) {
    lbox(0.04, 0.68, 0.96, 0.9, 0.12, 0.8, c);
    lbox(0.04, 0.18, 0.96, 0.86, 0.06, 0.36, c);
    lbox(0.13, 0.2, 0.5, 0.7, 0.36, 0.46, mix(c, '#ffffff', 0.15));
    lbox(0.5, 0.2, 0.87, 0.7, 0.36, 0.46, mix(c, '#ffffff', 0.15));
    lbox(0.0, 0.18, 0.13, 0.9, 0.06, 0.58, c);
    lbox(0.87, 0.18, 1.0, 0.9, 0.06, 0.58, c);
    lblob(0.26, 0.66, 0.62, 6, c2);
    lblob(0.74, 0.66, 0.62, 6, c3);
  }

  // ---------- Verstecke ----------
  const HIDE = {
    spind(t, occ) {
      lbox(0.16, 0.24, 0.84, 0.86, 0, 1.3, '#5b7db1');
      lfront(0.2, 0.49, 0.05, 1.25, 0.24, sh('#6d8fc4', 0));
      lfront(0.51, 0.8, 0.05, 1.25, 0.24, sh('#6d8fc4', 0));
      for (let k = 0; k < 3; k++) {
        lfront(0.26, 0.43, 1.02 + k * 0.06, 1.04 + k * 0.06, 0.24, sh('#22334f', 0), false);
        lfront(0.57, 0.74, 1.02 + k * 0.06, 1.04 + k * 0.06, 0.24, sh('#22334f', 0), false);
      }
      lfront(0.44, 0.47, 0.55, 0.75, 0.24, sh('#cfd8dc', 0), false);
      lfront(0.53, 0.56, 0.55, 0.75, 0.24, sh('#cfd8dc', 0), false);
      lfront(0.3, 0.4, 0.85, 0.93, 0.24, sh('#fff8e1', 0), false);
      if (occ) peekEyes(0.65, 1.08, 0.235, t);
    },
    schreibtisch(t, occ) {
      lbox(0.06, 0.12, 0.13, 0.9, 0, 0.5, '#8d6e63');
      lbox(0.87, 0.12, 0.94, 0.9, 0, 0.5, '#8d6e63');
      lbox(0.13, 0.74, 0.87, 0.8, 0.12, 0.5, '#a1887f');
      if (occ) {
        lfront(0.13, 0.87, 0.0, 0.5, 0.5, 'rgba(10,8,20,0.55)', false);
        peekEyes(0.5, 0.3, 0.12, t);
      }
      lbox(0.04, 0.1, 0.96, 0.92, 0.5, 0.57, '#c49a6c');
      lbox(0.36, 0.6, 0.64, 0.66, 0.57, 0.86, '#2b3034');
      lfront(0.38, 0.62, 0.6, 0.84, 0.6, sh('#64b5f6', 0.1 * Math.sin(t)), false);
      lbox(0.47, 0.66, 0.53, 0.72, 0.57, 0.62, '#2b3034');
      lbox(0.3, 0.25, 0.62, 0.4, 0.57, 0.59, '#eceff1');
      lcyl(0.78, 0.35, 0.57, 0.05, 0.09, '#ff7043');
    },
    vorhang(t, occ) {
      lbox(0.0, 0.46, 1.0, 0.54, 1.4, 1.46, '#8d6e63');
      const wob = occ ? Math.sin(t * 6) * 0.02 : 0;
      for (let k = 0; k < 8; k++) {
        const u0 = 0.02 + k * 0.12, v = 0.5 + ((k % 2) ? 0.05 : -0.05) + (occ && k > 2 && k < 6 ? -0.08 + wob : 0);
        lfront(u0, u0 + 0.12, 0.08, 1.4, v, sh('#b03a5b', (k % 2) ? -0.12 : 0.05), false);
      }
      C.beginPath(); lmv(0.02, 0.5, 0.08); lln(0.98, 0.5, 0.08); lln(0.98, 0.5, 1.4); lln(0.02, 0.5, 1.4); C.closePath();
      C.lineWidth = 1; C.strokeStyle = DIM ? 'rgba(10,12,30,0.4)' : OUTL; C.stroke();
      lfront(0.02, 0.98, 1.3, 1.36, 0.44, sh('#ffd54f', 0), false);
      if (occ) {
        // klassischer Gag: Schuhe schauen unter dem Vorhang hervor
        lbox(0.32, 0.25, 0.46, 0.45, 0, 0.07, '#3e2723');
        lbox(0.54, 0.27, 0.68, 0.45, 0, 0.07, '#3e2723');
      }
    },
    karton(t, occ) {
      const lift = occ ? Math.max(0, Math.sin(t * 2.2)) * 0.06 : 0;
      lbox(0.12, 0.12, 0.88, 0.88, lift, 0.78 + lift, '#c8a165');
      ltop(0.12, 0.45, 0.88, 0.55, 0.785 + lift, sh('#e8d2a2', 0), false);
      lfront(0.12, 0.88, 0.7 + lift, 0.78 + lift, 0.12, sh('#b38d55', 0), false);
      lfront(0.4, 0.6, 0.25 + lift, 0.4 + lift, 0.12, sh('#d32f2f', 0), false);
      lfront(0.48, 0.52, 0.3 + lift, 0.5 + lift, 0.12, sh('#d32f2f', 0), false);
      lfront(0.38, 0.62, 0.55 + lift, 0.63 + lift, 0.12, sh('#3e2723', 0));
      if (occ) peekEyes(0.5, 0.59 + lift, 0.11, t);
    }
  };
  function peekEyes(u, z, v, t) {
    const blink = (t % 3.2) < 0.12;
    const look = Math.sin(t * 1.3) * 0.015;
    for (const du of [-0.05, 0.05]) {
      const [px, py] = lpt(u + du, v, z);
      C.beginPath(); C.ellipse(px, py, 3.2, blink ? 0.5 : 2.4, 0, 0, TAU); C.fillStyle = '#ffffff'; C.fill();
      if (!blink) { C.beginPath(); C.arc(px + look * 60, py, 1.3, 0, TAU); C.fillStyle = '#111111'; C.fill(); }
    }
  }

  // ---------- Deko ----------
  const DECOR = {
    pflanze(t) {
      lcyl(0.5, 0.5, 0, 0.2, 0.34, '#d0703f', '#5d4037');
      const sway = Math.sin(t * 1.2) * 0.6;
      const leaves = [[0, 0.72, 9], [-6, 0.62, 7], [6, 0.6, 7], [-3, 0.86, 7], [4, 0.82, 6], [0, 0.98, 5]];
      const [bx, by] = lpt(0.5, 0.5, 0);
      for (let k = 0; k < leaves.length; k++) {
        const [dx, z, r] = leaves[k];
        C.beginPath(); C.arc(bx + dx + sway * (z - 0.5), by - z * ZH, r, 0, TAU);
        C.fillStyle = sh(k % 2 ? '#43a047' : '#66bb6a', 0); C.fill(); strokeOut(0.8);
      }
    },
    tisch(t) {
      tableLegs(0.14, 0.14, 0.86, 0.86, 0.52, '#6d4c41');
      lbox(0.08, 0.08, 0.92, 0.92, 0.52, 0.58, '#a1887f');
      lcyl(0.3, 0.4, 0.58, 0.06, 0.1, '#ffffff', '#6d4c41');
      lbox(0.5, 0.45, 0.8, 0.75, 0.58, 0.6, '#90a4ae');
    },
    regal(t) {
      lbox(0.08, 0.6, 0.92, 0.92, 0, 1.35, '#8d6e63');
      for (let s = 0; s < 3; s++) {
        const z = 0.1 + s * 0.42;
        lbox(0.12, 0.62, 0.88, 0.9, z, z + 0.04, '#6d4c41');
        let u = 0.14;
        for (let k = 0; u < 0.82; k++) {
          const w = 0.06 + hash(s, k, 4) * 0.05, hb = 0.22 + hash(k, s, 6) * 0.12;
          lfront(u, u + w, z + 0.04, z + 0.04 + hb, 0.64, sh(['#e53935', '#1e88e5', '#fdd835', '#43a047', '#8e24aa', '#fb8c00'][(s + k) % 6], 0));
          u += w + 0.01;
        }
      }
    },
    kiste(t) {
      lbox(0.14, 0.14, 0.86, 0.86, 0, 0.55, '#b07b45');
      for (let k = 0; k < 3; k++) lfront(0.14, 0.86, 0.04 + k * 0.17, 0.06 + k * 0.17, 0.14, sh('#7a4f25', 0), false);
      lfront(0.16, 0.2, 0.02, 0.53, 0.14, sh('#7a4f25', 0), false);
      lfront(0.8, 0.84, 0.02, 0.53, 0.14, sh('#7a4f25', 0), false);
    },
    sonnenschirm(t) {
      lell(0.5, 0.5, 0, 0.16, sh('#607d8b', 0), true);
      lcyl(0.5, 0.5, 0, 0.025, 1.55, '#eceff1');
      const [ax, ay] = lpt(0.5, 0.5, 1.68);
      const cols = ['#ff7043', '#ffffff'];
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * TAU, a1 = ((k + 1) / 8) * TAU;
        C.beginPath(); C.moveTo(ax, ay);
        L(0.5 + Math.cos(a0) * 0.62, 0.5 + Math.sin(a0) * 0.62); C.lineTo((WX - WY) * HW, (WX + WY) * HH - 1.3 * ZH);
        L(0.5 + Math.cos(a1) * 0.62, 0.5 + Math.sin(a1) * 0.62); C.lineTo((WX - WY) * HW, (WX + WY) * HH - 1.3 * ZH);
        C.closePath(); C.fillStyle = sh(cols[k % 2], (k > 1 && k < 6) ? -0.08 : 0.05); C.fill(); strokeOut(0.8);
      }
    },
    liege(t) {
      lbox(0.15, 0.05, 0.85, 0.95, 0, 0.22, '#eceff1');
      lbox(0.18, 0.08, 0.82, 0.62, 0.22, 0.28, '#4fc3f7');
      C.beginPath(); lmv(0.18, 0.62, 0.22); lln(0.82, 0.62, 0.22); lln(0.82, 0.92, 0.62); lln(0.18, 0.92, 0.62); C.closePath();
      fillOut(sh('#29b6f6', 0));
      lbox(0.35, 0.2, 0.65, 0.45, 0.28, 0.3, '#ffeb3b');
    },
    wasserspender(t) {
      lbox(0.28, 0.32, 0.72, 0.76, 0, 0.72, '#f5f5f5');
      lfront(0.38, 0.48, 0.5, 0.56, 0.32, sh('#2196f3', 0), false);
      lfront(0.52, 0.62, 0.5, 0.56, 0.32, sh('#f44336', 0), false);
      lcyl(0.5, 0.54, 0.72, 0.17, 0.4, '#8fd3ff', '#bfe7ff');
      lcyl(0.5, 0.54, 1.12, 0.06, 0.04, '#1565c0');
    },
    tresen(t) {
      lbox(0.04, 0.2, 0.96, 0.86, 0, 0.7, '#5c6bc0');
      lfront(0.04, 0.96, 0.25, 0.35, 0.2, sh('#ffca28', 0), false);
      lbox(0.0, 0.16, 1.0, 0.9, 0.7, 0.76, '#fafafa');
      lbox(0.55, 0.6, 0.85, 0.65, 0.76, 0.98, '#263238');
      lcyl(0.25, 0.45, 0.76, 0.06, 0.05, '#ffd54f', '#ffecb3');
    },
    palme(t) {
      const [bx, by] = lpt(0.5, 0.5, 0);
      lcyl(0.5, 0.5, 0, 0.2, 0.18, '#d0703f', '#5d4037');
      for (let k = 0; k < 6; k++) {
        C.beginPath(); C.ellipse(bx + Math.sin(k) * 1.2, by - 0.25 * ZH - k * 7.5, 4.2, 4.6, 0, 0, TAU);
        C.fillStyle = sh(k % 2 ? '#8d6e63' : '#a1887f', 0); C.fill(); strokeOut(0.7);
      }
      const topY = by - 0.25 * ZH - 45;
      const sway = Math.sin(t * 1.1) * 2;
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * TAU + 0.3;
        const ex = bx + Math.cos(a) * 26 + sway, ey = topY + Math.sin(a) * 11 + 9;
        C.beginPath(); C.moveTo(bx, topY);
        C.quadraticCurveTo(bx + Math.cos(a) * 14 + sway, topY - 12, ex, ey);
        C.quadraticCurveTo(bx + Math.cos(a) * 12, topY - 2, bx, topY);
        C.fillStyle = sh(k % 2 ? '#2e7d32' : '#43a047', 0); C.fill(); strokeOut(0.7);
      }
    },
    sofa_deko(t) { drawSofa('#26a69a', '#ffffff', '#ffab40'); },
    lampe(t) {
      lell(0.5, 0.5, 0, 0.14, sh('#37474f', 0), true);
      lcyl(0.5, 0.5, 0, 0.022, 1.2, '#455a64');
      lcyl(0.5, 0.5, 1.12, 0.17, 0.3, '#fff3c4', '#fffde7');
      // Zugschalter-Schnur (Zugschalter)
      lline(0.62, 0.5, 1.12, 0.62, 0.5, 0.86, sh('#795548', 0), 1);
      lblob(0.62, 0.5, 0.84, 2, '#ffca28', false);
    }
  };

  /** Bodenleuchten (dynamisch, additiv) */
  function drawLampGlow(o, t) {
    if (DIM) return;
    C.save();
    C.globalAlpha = 0.18 + 0.03 * Math.sin(t * 3);
    ell(o.x, o.y, 0, 1.0, '#ffe082');
    C.globalAlpha = 0.2;
    ell(o.x, o.y, 0, 0.55, '#fff8e1');
    C.restore();
  }

  function drawStatic(o, t, view) {
    LX = Math.floor(o.x); LY = Math.floor(o.y); LF = o.f || 'S';
    switch (o.k) {
      case 'wall': drawWall(o); break;
      case 'post': drawPost(o); break;
      case 'exit': drawExit(o, !!(view.me && view.me.exitOpen), t); break;
      case 'dev': {
        const fn = DEV[o.o.type];
        if (fn) fn(t); else lbox(0.2, 0.2, 0.8, 0.8, 0, 0.9, (deviceType(o.o.type) || {}).color || '#9e9e9e');
        break;
      }
      case 'hide': {
        const fn = HIDE[o.o.type] || HIDE.spind;
        fn(t, view.me && view.me.hidden === o.o.id);
        break;
      }
      case 'decor': {
        if (o.o.type === 'lampe') drawLampGlow(o, t);
        const fn = DECOR[o.o.type];
        if (fn) fn(t); else lbox(0.25, 0.25, 0.75, 0.75, 0, DECOR_H[o.o.type] || 0.6, '#9e9e9e');
        break;
      }
    }
  }

  // =====================================================================
  //  Figuren: Cartoon-Charaktere aus Avatar-Teilen
  // =====================================================================

  const DEF_SKINS = ['#ffe0c7', '#f5c6a0', '#e2a77a', '#c4875b', '#9a6440', '#6a4228'];
  const DEF_HAIRC = ['#2b2118', '#5b3a21', '#a3552c', '#e8b95b', '#f1e6c8', '#d8432a', '#7d8794', '#5b3fd1'];
  const DEF_OUTC = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#ec407a', '#546e7a', '#f5f5f5'];
  const INK = '#2a1f3d';

  function palettes() {
    const a = R.cat && R.cat.avatar;
    return {
      skins: (a && a.skins && a.skins.length) ? a.skins : DEF_SKINS,
      hair: (a && a.hairColors && a.hairColors.length) ? a.hairColors : DEF_HAIRC,
      out: (a && a.outfitColors && a.outfitColors.length) ? a.outfitColors : DEF_OUTC
    };
  }
  function pickCol(list, v, fallback) {
    if (typeof v === 'string' && v[0] === '#') return v;
    const i = (v | 0);
    return list[((i % list.length) + list.length) % list.length] || fallback;
  }

  // Farben pro Outfit (Hose, Schuhe, Ärmel)
  function outfitLook(outfit, cloth, skin) {
    switch (outfit) {
      case 'hoodie': return { pants: '#4a5060', shoes: '#f5f5f5', sleeve: cloth, torso: cloth };
      case 'anzug': return { pants: mix(cloth, '#000000', 0.25), shoes: '#1a1a1a', sleeve: cloth, torso: cloth };
      case 'arztkittel': return { pants: '#7fa8cc', shoes: '#ffffff', sleeve: '#f6f8fa', torso: '#f6f8fa' };
      case 'latzhose': return { pants: cloth, shoes: '#6d4c41', sleeve: '#f2f2f2', torso: '#f2f2f2' };
      case 'warnweste': return { pants: '#3a3f4b', shoes: '#3e2723', sleeve: cloth, torso: cloth };
      case 'pyjama': return { pants: mix(cloth, '#ffffff', 0.35), shoes: '#ffb3c7', sleeve: mix(cloth, '#ffffff', 0.35), torso: mix(cloth, '#ffffff', 0.35) };
      case 'kleid': return { pants: skin, shoes: '#c62828', sleeve: skin, torso: cloth, bare: true };
      case 'trainingsanzug': return { pants: cloth, shoes: '#fafafa', sleeve: cloth, torso: cloth };
      case 'bademantel': return { pants: skin, shoes: '#ffffff', sleeve: mix(cloth, '#ffffff', 0.55), torso: mix(cloth, '#ffffff', 0.55), bare: true };
      case 'schuerze': return { pants: '#394050', shoes: '#212121', sleeve: '#eef0f3', torso: '#eef0f3' };
      case 'butler': return { pants: '#1d1f24', shoes: '#0d0d0d', sleeve: '#1d1f24', torso: '#1d1f24' };
      default: return { pants: '#33466b', shoes: '#2b2b33', sleeve: cloth, torso: cloth };
    }
  }

  function inkStroke(g, w) { g.lineWidth = w || 1.3; g.strokeStyle = INK; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke(); }
  function fillInk(g, col, w) { g.fillStyle = col; g.fill(); inkStroke(g, w); }
  function limb(g, x0, y0, x1, y1, w, col) {
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1);
    g.lineWidth = w + 2.4; g.strokeStyle = INK; g.stroke();
    g.lineWidth = w; g.strokeStyle = col; g.stroke();
  }
  function circ(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); }

  /**
   * Zeichnet eine Figur; Ursprung = Füße, 1 Einheit = 1 Iso-Pixel (Zoom 1).
   * o: { f (±1), back, walk (Phase|null), pose, t, seed, skinTint, clothTint, face, mummy, noHair }
   */
  function drawFigure(g, av, o) {
    av = av || {};
    o = o || {};
    const P = palettes();
    const t = o.t || 0;
    let skin = pickCol(P.skins, av.skin, DEF_SKINS[1]);
    let hairC = pickCol(P.hair, av.hairColor, DEF_HAIRC[0]);
    let cloth = pickCol(P.out, av.outfitColor, DEF_OUTC[1]);
    const outfit = av.outfit || 'hemd';
    let look = outfitLook(outfit, cloth, skin);
    let pants = look.pants, shoes = look.shoes, sleeve = look.sleeve, torsoC = look.torso;
    if (o.skinTint) skin = mix(skin, o.skinTint[0], o.skinTint[1]);
    if (o.clothTint) {
      const [tc, ta] = o.clothTint;
      cloth = mix(cloth, tc, ta); pants = mix(pants, tc, ta); sleeve = mix(sleeve, tc, ta); torsoC = mix(torsoC, tc, ta); hairC = mix(hairC, tc, ta * 0.8);
      if (look.bare) { pants = mix(look.pants, tc, ta); }
    }
    const mummy = !!o.mummy;
    if (mummy) { const B = '#efe7d6'; skin = B; cloth = B; pants = B; sleeve = B; torsoC = B; shoes = '#d9cfbb'; }
    const back = !!o.back;
    const pose = o.pose || 'idle';
    const walking = o.walk !== null && o.walk !== undefined;
    const ph = walking ? o.walk : 0;
    const bob = walking ? -Math.abs(Math.sin(ph)) * 1.6 : Math.sin(t * 2 + (o.seed || 0) * 9) * 0.5;

    g.save();
    if (o.f === -1) g.scale(-1, 1);
    const hipY = -15, shY = -31 + bob, headY = -44 + bob, HR = 12.5;
    const fx = back ? 0 : 2.4;

    // ---- Haare hinten (vor dem Kopf zu zeichnen) ----
    if (!mummy && !o.noHair) drawHairBack(g, av.hair, hairC, headY, HR, back, t);
    // Kapuze / Frack-Schöße hinten
    if (!mummy && outfit === 'hoodie' && !back) { g.beginPath(); g.ellipse(-2, shY + 1, 10, 5, 0, 0, TAU); fillInk(g, sh(cloth, -0.18)); }
    if (!mummy && outfit === 'butler') {
      g.beginPath(); g.moveTo(-8, hipY - 2); g.lineTo(-10, -4); g.lineTo(-3, -7); g.lineTo(0, hipY); g.closePath(); fillInk(g, '#15161a');
    }

    // ---- Beine ----
    const legs = [[-4.3, 0], [4.3, Math.PI]];
    for (const [lx, off] of legs) {
      const s = walking ? Math.sin(ph + off) : 0;
      const lift = walking ? Math.max(0, -Math.cos(ph + off)) * 2.6 : 0;
      const footX = lx * 0.95 + s * 4.6, footY = -2.2 - lift;
      if (pose === 'lie') continue;
      limb(g, lx * 0.85, hipY + bob, footX, footY, 6.4, pants);
      if (look.bare && !mummy) limb(g, lx * 0.85, hipY + 5 + bob, footX, footY, 5.6, skin);
      g.beginPath(); g.ellipse(footX + 1.4, footY + 1.4, 4.6, 2.8, 0, 0, TAU); fillInk(g, shoes, 1.1);
      if (mummy) { g.beginPath(); g.moveTo(lx - 3, hipY + 6); g.lineTo(lx + 3, hipY + 3); inkStroke(g, 0.6); }
    }

    // ---- Arme: Positionen ----
    const shL = [-8.6, shY + 3], shR = [8.6, shY + 3];
    const sw = walking ? Math.sin(ph) : Math.sin(t * 1.5 + (o.seed || 0) * 5) * 0.08;
    let hL = [shL[0] - 1.5 - sw * 5, shL[1] + 12.5], hR = [shR[0] + 1.5 + sw * 5, shR[1] + 12.5];
    if (pose === 'wave') { const w = Math.sin(t * 11) * 3; hR = [shR[0] + 6 + w, shR[1] - 13]; }
    if (pose === 'cheer') { const w = Math.sin(t * 9) * 2; hL = [shL[0] - 6, shL[1] - 13 + w]; hR = [shR[0] + 6, shR[1] - 13 - w]; }
    if (pose === 'zombie') { hL = [shL[0] + 15, shL[1] + 1 + Math.sin(t * 4) * 1.5]; hR = [shR[0] + 13, shR[1] + 2 - Math.sin(t * 4) * 1.5]; }
    if (pose === 'flail') { hL = [shL[0] - 7, shL[1] - 9 + Math.sin(t * 16) * 4]; hR = [shR[0] + 7, shR[1] - 9 + Math.cos(t * 16) * 4]; }
    if (pose === 'shield') { hL = [shL[0] + 9, shL[1] - 12]; hR = [shR[0] + 3, shR[1] - 14]; }
    if (pose === 'work') { const w = Math.sin(t * 22) * 1.4; hL = [shL[0] + 12, shL[1] + 7 + w]; hR = [shR[0] + 9, shR[1] + 8 - w]; }
    const drawArm = (sh0, hand) => {
      limb(g, sh0[0], sh0[1], hand[0], hand[1], 5.4, sleeve);
      if (outfit === 'trainingsanzug' && !mummy) {
        g.beginPath(); g.moveTo(sh0[0], sh0[1]); g.lineTo(hand[0], hand[1]); g.lineWidth = 1.2; g.strokeStyle = '#ffffff'; g.stroke();
      }
      circ(g, hand[0], hand[1], 3.2); fillInk(g, mummy ? '#efe7d6' : skin, 1.1);
    };
    if (!back) drawArm(shL, hL);

    // ---- Rumpf ----
    torsoPath(g, shY, hipY + bob);
    fillInk(g, torsoC, 1.4);
    if (!mummy) drawOutfit(g, outfit, cloth, skin, shY, hipY + bob, back, t);
    else bandageStripes(g, -10, shY, 20, hipY + bob - shY + 2, t);

    if (back) { drawArm(shL, hL); }
    drawArm(shR, hR);

    // Lange Mäntel über die Beine
    if (!mummy && (outfit === 'arztkittel' || outfit === 'bademantel')) {
      const c = outfit === 'arztkittel' ? '#f6f8fa' : mix(cloth, '#ffffff', 0.55);
      g.beginPath(); g.moveTo(-9, hipY + bob - 1); g.lineTo(9, hipY + bob - 1); g.lineTo(10.5, -5); g.lineTo(-10.5, -5); g.closePath(); fillInk(g, c, 1.3);
      if (!back) { g.beginPath(); g.moveTo(0.5, hipY + bob); g.lineTo(0.5, -5.5); inkStroke(g, 0.8); }
      if (outfit === 'bademantel') { g.beginPath(); g.rect(-9, hipY + bob - 2, 18, 3); fillInk(g, sh(cloth, -0.1), 1); }
    }
    if (!mummy && outfit === 'kleid') {
      g.beginPath(); g.moveTo(-8.5, hipY + bob - 2); g.lineTo(8.5, hipY + bob - 2); g.lineTo(12.5, -6); g.quadraticCurveTo(0, -3, -12.5, -6); g.closePath(); fillInk(g, cloth, 1.3);
      for (let k = 0; k < 5; k++) { circ(g, -8 + k * 4, -9 - (k % 2) * 3, 1); g.fillStyle = 'rgba(255,255,255,0.75)'; g.fill(); }
    }

    // ---- Kopf ----
    // Ohren
    if (!mummy) {
      circ(g, -HR + 0.5, headY + 1, 3.2); fillInk(g, skin, 1.1);
      if (back) { circ(g, HR - 0.5, headY + 1, 3.2); fillInk(g, skin, 1.1); }
    }
    g.beginPath(); g.ellipse(0, headY, HR, HR * 0.97, 0, 0, TAU); fillInk(g, skin, 1.5);
    if (!back && !mummy) { g.beginPath(); g.ellipse(-4, headY - 6, 4, 2.5, -0.5, 0, TAU); g.fillStyle = 'rgba(255,255,255,0.22)'; g.fill(); }
    if (mummy) {
      bandageStripes(g, -HR, headY - HR, HR * 2, HR * 2, t, true, headY, HR);
      if (!back) {
        g.fillStyle = '#2a1f3d'; g.fillRect(fx - 8, headY - 3.5, 16, 4.4);
        circ(g, fx - 4, headY - 1.3, 1.4); g.fillStyle = '#ffffff'; g.fill();
        circ(g, fx + 4, headY - 1.3, 1.4); g.fill();
      }
    } else if (!back) {
      drawFace(g, av.face || 'grinsen', o.face || 'normal', fx, headY, skin, hairC, t, o.seed || 0);
    }
    if (!mummy && !o.noHair) drawHairFront(g, av.hair || 'kurz', hairC, headY, HR, back, t, fx);
    if (!mummy) drawAcc(g, av.acc || 'keins', headY, HR, back, t, fx, shY, cloth);
    g.restore();
  }

  function torsoPath(g, top, bot) {
    g.beginPath();
    g.moveTo(-9.5 + 4, top);
    g.lineTo(9.5 - 4, top);
    g.quadraticCurveTo(10, top, 10, top + 5);
    g.lineTo(8.8, bot - 2);
    g.quadraticCurveTo(8.6, bot + 1, 5, bot + 1);
    g.lineTo(-5, bot + 1);
    g.quadraticCurveTo(-8.6, bot + 1, -8.8, bot - 2);
    g.lineTo(-10, top + 5);
    g.quadraticCurveTo(-10, top, -9.5 + 4, top);
    g.closePath();
  }

  function bandageStripes(g, x, y, w, h, t, head, hy, hr) {
    g.save();
    if (head) { g.beginPath(); g.ellipse(0, hy, hr, hr * 0.97, 0, 0, TAU); g.clip(); }
    else { torsoPath(g, y, y + h - 2); g.clip(); }
    g.strokeStyle = 'rgba(150,130,100,0.75)'; g.lineWidth = 1;
    for (let k = -3; k < 9; k++) {
      g.beginPath(); g.moveTo(x - 4, y + k * 4); g.lineTo(x + w + 4, y + k * 4 + 5 + (k % 2) * 3); g.stroke();
    }
    g.restore();
  }

  function drawOutfit(g, outfit, cloth, skin, top, bot, back, t) {
    if (back) {
      if (outfit === 'hoodie') { g.beginPath(); g.ellipse(0, top + 3, 8, 5, 0, 0, Math.PI); fillInk(g, sh(cloth, -0.15)); }
      if (outfit === 'warnweste') { vestBack(g, top, bot); }
      if (outfit === 'latzhose') { g.beginPath(); g.moveTo(-6, top); g.lineTo(5, bot - 4); g.moveTo(6, top); g.lineTo(-5, bot - 4); g.lineWidth = 2.6; g.strokeStyle = cloth; g.stroke(); }
      if (outfit === 'schuerze') { g.beginPath(); g.moveTo(-9, bot - 6); g.lineTo(9, bot - 6); g.lineWidth = 1.6; g.strokeStyle = cloth; g.stroke(); }
      if (outfit === 'trainingsanzug') { g.fillStyle = '#ffffff'; g.fillRect(-9.6, top + 4, 1.6, bot - top - 5); g.fillRect(8, top + 4, 1.6, bot - top - 5); }
      if (outfit === 'butler') { g.beginPath(); g.moveTo(0, top + 6); g.lineTo(0, bot); inkStroke(g, 0.8); }
      return;
    }
    switch (outfit) {
      case 'hemd': {
        g.beginPath(); g.moveTo(-5, top); g.lineTo(0, top + 5); g.lineTo(5, top); g.lineTo(4, top + 3.5); g.lineTo(0, top + 6.5); g.lineTo(-4, top + 3.5); g.closePath();
        fillInk(g, mix(cloth, '#ffffff', 0.6), 1);
        for (let k = 0; k < 3; k++) { circ(g, 0.5, top + 9 + k * 4, 0.9); g.fillStyle = sh(cloth, -0.35); g.fill(); }
        g.fillStyle = sh(cloth, -0.18); g.fillRect(3.5, top + 7, 4, 3.4);
        break;
      }
      case 'hoodie': {
        g.beginPath(); g.moveTo(-6, top); g.quadraticCurveTo(0, top + 6, 6, top); inkStroke(g, 1);
        rr(g, -6, bot - 8, 12, 6, 2.5); fillInk(g, sh(cloth, -0.12), 1);
        g.beginPath(); g.moveTo(-2.5, top + 2); g.lineTo(-2.8, top + 8); g.moveTo(2.5, top + 2); g.lineTo(2.8, top + 8);
        g.lineWidth = 1.1; g.strokeStyle = '#ffffff'; g.stroke();
        break;
      }
      case 'anzug': {
        g.beginPath(); g.moveTo(-4.5, top); g.lineTo(0, top + 10); g.lineTo(4.5, top); g.closePath(); fillInk(g, '#ffffff', 1);
        g.beginPath(); g.moveTo(0, top + 2); g.lineTo(1.6, top + 4); g.lineTo(0.8, top + 10); g.lineTo(0, top + 11.5); g.lineTo(-0.8, top + 10); g.lineTo(-1.6, top + 4); g.closePath(); fillInk(g, '#c62828', 0.8);
        g.beginPath(); g.moveTo(-4.5, top); g.lineTo(-1.5, top + 10); g.lineTo(-6.5, top + 6); g.closePath(); fillInk(g, sh(cloth, -0.2), 1);
        g.beginPath(); g.moveTo(4.5, top); g.lineTo(1.5, top + 10); g.lineTo(6.5, top + 6); g.closePath(); fillInk(g, sh(cloth, -0.2), 1);
        circ(g, 0, top + 13, 0.9); g.fillStyle = '#111'; g.fill();
        break;
      }
      case 'arztkittel': {
        g.beginPath(); g.moveTo(-4, top); g.lineTo(0, top + 8); g.lineTo(4, top); g.closePath(); fillInk(g, cloth, 1);
        g.beginPath(); g.moveTo(-4, top); g.lineTo(-1, top + 9); g.lineTo(-6, top + 6); g.closePath(); fillInk(g, '#e3e9ef', 1);
        g.beginPath(); g.moveTo(4, top); g.lineTo(1, top + 9); g.lineTo(6, top + 6); g.closePath(); fillInk(g, '#e3e9ef', 1);
        rr(g, 3, top + 10, 4.5, 4, 1); fillInk(g, '#ffffff', 0.8);
        g.fillStyle = '#1e88e5'; g.fillRect(4.2, top + 8.5, 1, 3);
        break;
      }
      case 'latzhose': {
        rr(g, -6.5, top + 7, 13, bot - top - 6, 2); fillInk(g, cloth, 1.1);
        g.beginPath(); g.moveTo(-7, top); g.lineTo(-5.5, top + 8); g.moveTo(7, top); g.lineTo(5.5, top + 8); g.lineWidth = 2.6; g.strokeStyle = cloth; g.stroke();
        circ(g, -5, top + 8.5, 1.1); g.fillStyle = '#ffd54f'; g.fill(); circ(g, 5, top + 8.5, 1.1); g.fill();
        rr(g, -3, top + 10, 6, 4, 1); fillInk(g, sh(cloth, -0.15), 0.8);
        break;
      }
      case 'warnweste': {
        const V = '#d4ff3a';
        g.beginPath(); g.moveTo(-10, top + 5); g.quadraticCurveTo(-10, top, -6, top); g.lineTo(-2, top + 8); g.lineTo(-2.5, bot + 1); g.lineTo(-8.8, bot); g.closePath(); fillInk(g, V, 1.1);
        g.beginPath(); g.moveTo(10, top + 5); g.quadraticCurveTo(10, top, 6, top); g.lineTo(2, top + 8); g.lineTo(2.5, bot + 1); g.lineTo(8.8, bot); g.closePath(); fillInk(g, V, 1.1);
        g.fillStyle = '#e0e6ea'; g.fillRect(-9.6, top + 10, 7.4, 2); g.fillRect(2.2, top + 10, 7.4, 2);
        g.fillRect(-9.2, top + 14, 7, 2); g.fillRect(2.2, top + 14, 7, 2);
        break;
      }
      case 'pyjama': {
        g.save(); torsoPath(g, top, bot); g.clip();
        g.fillStyle = sh(cloth, -0.1);
        for (let k = -10; k < 12; k += 4) g.fillRect(k, top, 1.6, bot - top + 2);
        g.restore();
        for (let k = 0; k < 3; k++) { circ(g, 0.5, top + 5 + k * 4, 0.9); g.fillStyle = '#ffffff'; g.fill(); }
        break;
      }
      case 'kleid': {
        g.beginPath(); g.moveTo(-5, top); g.quadraticCurveTo(0, top + 5, 5, top); inkStroke(g, 1);
        g.fillStyle = sh(cloth, -0.18); g.fillRect(-8.6, bot - 4, 17.2, 2.4);
        break;
      }
      case 'trainingsanzug': {
        g.fillStyle = '#ffffff'; g.fillRect(-9.6, top + 4, 1.6, bot - top - 5); g.fillRect(8, top + 4, 1.6, bot - top - 5);
        g.beginPath(); g.moveTo(0.5, top + 1); g.lineTo(0.5, bot); g.lineWidth = 1; g.strokeStyle = sh(cloth, -0.35); g.stroke();
        g.beginPath(); g.moveTo(-4, top); g.lineTo(0.5, top + 3); g.lineTo(5, top); inkStroke(g, 1);
        break;
      }
      case 'bademantel': {
        g.beginPath(); g.moveTo(-5, top); g.lineTo(0.5, top + 9); g.lineTo(5.5, top); g.closePath(); fillInk(g, skin, 1);
        g.beginPath(); g.moveTo(-5, top); g.lineTo(1, top + 10); g.lineTo(1, bot); inkStroke(g, 1);
        break;
      }
      case 'schuerze': {
        g.beginPath(); g.moveTo(-6, top + 6); g.lineTo(6, top + 6); g.lineTo(7.5, bot + 1); g.lineTo(-7.5, bot + 1); g.closePath(); fillInk(g, cloth, 1.1);
        g.beginPath(); g.moveTo(-5, top + 6); g.lineTo(-3, top); g.moveTo(5, top + 6); g.lineTo(3, top); g.lineWidth = 1.5; g.strokeStyle = cloth; g.stroke();
        rr(g, -3, top + 10, 6, 3.5, 1); fillInk(g, sh(cloth, -0.15), 0.8);
        break;
      }
      case 'butler': {
        g.beginPath(); g.moveTo(-4, top); g.lineTo(0, top + 12); g.lineTo(4, top); g.closePath(); fillInk(g, '#ffffff', 1);
        g.beginPath(); g.moveTo(-3.5, top + 1.5); g.lineTo(-0.3, top + 3); g.lineTo(-3.5, top + 4.5); g.closePath(); fillInk(g, cloth, 0.8);
        g.beginPath(); g.moveTo(3.5, top + 1.5); g.lineTo(0.3, top + 3); g.lineTo(3.5, top + 4.5); g.closePath(); fillInk(g, cloth, 0.8);
        circ(g, 0, top + 3, 1.1); fillInk(g, sh(cloth, -0.2), 0.6);
        for (let k = 0; k < 2; k++) { circ(g, 0, top + 8 + k * 3, 0.7); g.fillStyle = '#9e9e9e'; g.fill(); }
        break;
      }
    }
  }
  function vestBack(g, top, bot) {
    torsoPath(g, top, bot); g.fillStyle = '#d4ff3a'; g.fill(); inkStroke(g, 1.1);
    g.fillStyle = '#e0e6ea'; g.fillRect(-9.4, top + 9, 18.8, 2.2); g.fillRect(-9, top + 14, 18, 2.2);
  }

  function drawFace(g, face, mode, fx, hy, skin, hairC, t, seed) {
    const ex1 = fx - 4.6, ex2 = fx + 4.4, ey = hy - 1.2;
    const blink = ((t + seed * 7) % 3.7) < 0.13;
    const pupil = 0.9;
    const eyeWhite = (x, ry) => { g.beginPath(); g.ellipse(x, ey, 2.9, ry, 0, 0, TAU); g.fillStyle = '#ffffff'; g.fill(); inkStroke(g, 0.9); };
    const pup = (x, r) => { circ(g, x + pupil, ey + 0.4, r); g.fillStyle = INK; g.fill(); circ(g, x + pupil + 0.7, ey - 0.5, r * 0.35); g.fillStyle = '#ffffff'; g.fill(); };
    const cheeks = (a) => { g.fillStyle = 'rgba(255,110,120,' + a + ')'; circ(g, fx - 7.2, hy + 3, 2.4); g.fill(); circ(g, fx + 7.6, hy + 3, 2.4); g.fill(); };
    // Nase
    const nose = () => { g.beginPath(); g.ellipse(fx + 1.3, hy + 2.6, 1.6, 1.2, 0, 0, TAU); g.fillStyle = sh(skin, -0.16); g.fill(); };

    if (mode === 'shock') {
      eyeWhite(ex1, 3.9); eyeWhite(ex2, 3.9); pup(ex1, 1.1); pup(ex2, 1.1);
      g.beginPath(); g.moveTo(ex1 - 3, ey - 6.5); g.lineTo(ex1 + 2, ey - 7.5); g.moveTo(ex2 - 2, ey - 7.5); g.lineTo(ex2 + 3, ey - 6.5); inkStroke(g, 1.2);
      nose(); g.beginPath(); g.ellipse(fx + 0.6, hy + 7, 2.4, 3.2, 0, 0, TAU); fillInk(g, '#5d1a24', 1);
      cheeks(0.25); return;
    }
    if (mode === 'dizzy') {
      for (const x of [ex1, ex2]) {
        g.beginPath();
        for (let a = 0; a < 12; a += 0.4) { const r = 0.25 * a; const px = x + Math.cos(a + t * 8) * r, py = ey + Math.sin(a + t * 8) * r; if (!a) g.moveTo(px, py); else g.lineTo(px, py); }
        inkStroke(g, 0.9);
      }
      nose(); g.beginPath(); g.moveTo(fx - 3, hy + 7); for (let k = 0; k <= 6; k++) g.lineTo(fx - 3 + k, hy + 7 + (k % 2 ? -1 : 1)); inkStroke(g, 1);
      return;
    }
    if (mode === 'squint' || mode === 'yuck' || mode === 'hot') {
      g.beginPath(); g.moveTo(ex1 - 2.6, ey - 1.5); g.lineTo(ex1 + 1.8, ey); g.lineTo(ex1 - 2.6, ey + 1.5);
      g.moveTo(ex2 + 2.6, ey - 1.5); g.lineTo(ex2 - 1.8, ey); g.lineTo(ex2 + 2.6, ey + 1.5); inkStroke(g, 1.3);
      nose();
      if (mode === 'yuck') {
        g.beginPath(); g.moveTo(fx - 3.5, hy + 6.5); g.quadraticCurveTo(fx + 0.5, hy + 4.5, fx + 4.5, hy + 6.5); inkStroke(g, 1.1);
        g.beginPath(); g.ellipse(fx + 1, hy + 8.4, 2, 2.6, 0, 0, Math.PI); fillInk(g, '#ff7aa2', 0.9);
      } else {
        g.beginPath(); g.ellipse(fx + 0.6, hy + 6.8, 4.2, 3.2, 0, 0, TAU); fillInk(g, '#5d1a24', 1);
        g.fillStyle = '#ffffff'; g.fillRect(fx - 2.6, hy + 4, 6.4, 1.4);
        g.beginPath(); g.ellipse(fx + 0.8, hy + 8.4, 2.2, 1.2, 0, 0, TAU); g.fillStyle = '#ff7aa2'; g.fill();
      }
      cheeks(0.5); return;
    }
    if (mode === 'happy') {
      g.beginPath(); g.arc(ex1, ey + 1, 2.4, Math.PI * 1.1, Math.PI * 1.9); g.moveTo(ex2 - 2.2, ey + 0.6); g.arc(ex2, ey + 1, 2.4, Math.PI * 1.1, Math.PI * 1.9); inkStroke(g, 1.3);
      nose(); g.beginPath(); g.arc(fx + 0.6, hy + 4.2, 4.6, 0.1, Math.PI - 0.1); g.closePath(); fillInk(g, '#5d1a24', 1);
      cheeks(0.45); return;
    }
    if (mode === 'sooty') {
      eyeWhite(ex1, blink ? 0.4 : 3.2); eyeWhite(ex2, blink ? 0.4 : 3.2);
      if (!blink) { pup(ex1, 1.3); pup(ex2, 1.3); }
      g.beginPath(); g.moveTo(fx - 2.5, hy + 6.5); g.lineTo(fx + 3.5, hy + 6.2); g.lineWidth = 1.2; g.strokeStyle = '#ffffff'; g.stroke();
      return;
    }

    // ---- Normale Gesichter ----
    if (face === 'cool') {
      eyeWhite(ex1, 3.2); eyeWhite(ex2, 3.2); pup(ex1, 1.6); pup(ex2, 1.6);
      g.fillStyle = skin; g.fillRect(ex1 - 3.2, ey - 3.6, 6.4, 3.2); g.fillRect(ex2 - 3.2, ey - 3.6, 6.4, 3.2);
      g.beginPath(); g.moveTo(ex1 - 3, ey - 0.4); g.lineTo(ex1 + 3, ey - 0.4); g.moveTo(ex2 - 3, ey - 0.4); g.lineTo(ex2 + 3, ey - 0.4); inkStroke(g, 1.1);
    } else if (blink) {
      g.beginPath(); g.moveTo(ex1 - 2.6, ey); g.lineTo(ex1 + 2.6, ey); g.moveTo(ex2 - 2.6, ey); g.lineTo(ex2 + 2.6, ey); inkStroke(g, 1.2);
    } else {
      const big = face === 'staunend' ? 4 : 3.5;
      eyeWhite(ex1, big); eyeWhite(ex2, big); pup(ex1, face === 'staunend' ? 1.4 : 1.75); pup(ex2, face === 'staunend' ? 1.4 : 1.75);
    }
    // Augenbrauen
    g.beginPath();
    if (face === 'frech') { g.moveTo(ex1 - 2.8, ey - 5.3); g.lineTo(ex1 + 2.2, ey - 4.3); g.moveTo(ex2 - 2.2, ey - 6.8); g.quadraticCurveTo(ex2, ey - 8, ex2 + 2.8, ey - 6.5); }
    else if (face === 'staunend') { g.moveTo(ex1 - 2.6, ey - 7); g.quadraticCurveTo(ex1, ey - 8.3, ex1 + 2.4, ey - 7); g.moveTo(ex2 - 2.4, ey - 7); g.quadraticCurveTo(ex2, ey - 8.3, ex2 + 2.6, ey - 7); }
    else if (face !== 'cool') { g.moveTo(ex1 - 2.6, ey - 5.4); g.quadraticCurveTo(ex1, ey - 6.4, ex1 + 2.4, ey - 5.6); g.moveTo(ex2 - 2.4, ey - 5.6); g.quadraticCurveTo(ex2, ey - 6.4, ex2 + 2.6, ey - 5.4); }
    g.lineWidth = 1.3; g.strokeStyle = (face === 'vollbart' || face === 'schnurrbart') ? hairC : INK; g.lineCap = 'round'; g.stroke();
    nose();
    // Mund
    if (face === 'staunend') {
      g.beginPath(); g.ellipse(fx + 0.6, hy + 7, 2, 2.6, 0, 0, TAU); fillInk(g, '#5d1a24', 1);
    } else if (face === 'frech') {
      g.beginPath(); g.moveTo(fx - 3, hy + 6); g.quadraticCurveTo(fx + 1, hy + 8.6, fx + 4.6, hy + 4.8); inkStroke(g, 1.3);
      g.beginPath(); g.ellipse(fx + 2.6, hy + 7.4, 1.4, 1.8, -0.4, 0, Math.PI); fillInk(g, '#ff7aa2', 0.8);
    } else if (face === 'cool') {
      g.beginPath(); g.moveTo(fx - 2.5, hy + 6.6); g.quadraticCurveTo(fx + 1, hy + 7.8, fx + 4, hy + 5.8); inkStroke(g, 1.3);
    } else if (face === 'vollbart') {
      g.beginPath();
      g.moveTo(-10.8, hy + 2); g.quadraticCurveTo(-10, hy + 11.5, fx + 0.5, hy + 12.8); g.quadraticCurveTo(10.8, hy + 11.5, 11.4, hy + 2);
      g.quadraticCurveTo(9, hy + 5.5, fx + 0.5, hy + 4.6); g.quadraticCurveTo(-8, hy + 5.5, -10.8, hy + 2); g.closePath();
      fillInk(g, hairC, 1.1);
      g.beginPath(); g.ellipse(fx + 0.6, hy + 7.4, 2.8, 1.5, 0, 0, TAU); fillInk(g, '#5d1a24', 0.8);
      g.beginPath(); g.ellipse(fx + 1.3, hy + 2.6, 1.6, 1.2, 0, 0, TAU); g.fillStyle = sh(skin, -0.16); g.fill();
    } else {
      // grinsen / schnurrbart / sommersprossen
      g.beginPath(); g.moveTo(fx - 3.6, hy + 5.4); g.quadraticCurveTo(fx + 0.6, hy + 10.6, fx + 4.8, hy + 5.4); g.closePath(); fillInk(g, '#5d1a24', 1.1);
      g.fillStyle = '#ffffff'; g.fillRect(fx - 2.4, hy + 5.6, 6, 1.3);
      g.beginPath(); g.ellipse(fx + 0.6, hy + 8.2, 1.8, 0.9, 0, 0, TAU); g.fillStyle = '#ff7aa2'; g.fill();
      if (face === 'schnurrbart') {
        g.beginPath();
        g.moveTo(fx + 0.6, hy + 4); g.quadraticCurveTo(fx - 3, hy + 2.5, fx - 6, hy + 5.6); g.quadraticCurveTo(fx - 2.5, hy + 5.6, fx + 0.6, hy + 4.8);
        g.quadraticCurveTo(fx + 3.6, hy + 5.6, fx + 7, hy + 5.6); g.quadraticCurveTo(fx + 4, hy + 2.5, fx + 0.6, hy + 4); g.closePath();
        fillInk(g, hairC, 0.9);
      }
      if (face === 'sommersprossen') {
        g.fillStyle = sh(skin, -0.32);
        for (const [dx, dy] of [[-8, 1.5], [-6.2, 2.6], [-7.6, 3.8], [6.6, 1.5], [8.4, 2.6], [7, 3.8]]) { circ(g, fx + dx, hy + dy, 0.65); g.fill(); }
      }
    }
    cheeks(face === 'frech' ? 0.3 : 0.22);
  }

  function drawHairBack(g, hair, col, hy, HR, back, t) {
    switch (hair) {
      case 'lang':
        rr(g, -HR - 1.5, hy - 6, HR * 2 + 3, 25, 7); fillInk(g, sh(col, -0.08), 1.3); break;
      case 'zopf': {
        if (back) break;
        const sw = Math.sin(t * 3) * 1.5;
        g.beginPath(); g.moveTo(-HR + 1, hy - 5); g.quadraticCurveTo(-HR - 9 + sw, hy + 4, -HR - 5 + sw, hy + 16); g.quadraticCurveTo(-HR - 2, hy + 6, -HR + 3, hy + 1); g.closePath();
        fillInk(g, sh(col, -0.06), 1.2);
        circ(g, -HR - 0.5, hy - 2, 2.4); fillInk(g, '#e53935', 0.9);
        break;
      }
      case 'afro':
        circ(g, 0, hy - 3, HR + 6.5); fillInk(g, col, 1.4);
        for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; circ(g, Math.cos(a) * (HR + 6), hy - 3 + Math.sin(a) * (HR + 6), 3.4); g.fillStyle = col; g.fill(); }
        break;
      case 'locken':
        for (let k = 0; k < 7; k++) { const a = Math.PI * (0.9 + k * 0.2); circ(g, Math.cos(a) * (HR + 1), hy + Math.sin(a) * (HR + 1) + 4, 4); fillInk(g, sh(col, -0.05), 1); }
        break;
    }
  }

  function drawHairFront(g, hair, col, hy, HR, back, t, fx) {
    const top = hy - HR;
    if (back) {
      if (hair === 'glatze') { g.beginPath(); g.ellipse(-3, hy - 6, 4, 2.4, -0.4, 0, TAU); g.fillStyle = 'rgba(255,255,255,0.35)'; g.fill(); return; }
      if (hair === 'irokese') {
        g.beginPath(); g.moveTo(-2.5, top + 1); for (let k = 0; k < 5; k++) { g.lineTo(-2 + k * 1.2, top - 8 + (k % 2) * 3); } g.lineTo(2.5, hy + 4); g.lineTo(-2.5, hy + 4); g.closePath(); fillInk(g, col, 1.1); return;
      }
      g.save();
      g.beginPath(); g.ellipse(0, hy, HR + 0.6, HR * 0.97 + 0.6, 0, 0, TAU); g.clip();
      const cut = hair === 'kurz' || hair === 'seitenscheitel' || hair === 'wuschel' ? hy + 5 : hy + HR + 2;
      g.fillStyle = col; g.fillRect(-HR - 2, top - 2, HR * 2 + 4, cut - top + 2);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.ellipse(-3, hy - 6, 5, 3, -0.3, 0, TAU); g.fill();
      g.restore();
      g.beginPath(); g.ellipse(0, hy, HR + 0.3, HR * 0.97 + 0.3, 0, Math.PI, 0); inkStroke(g, 1.3);
      if (hair === 'dutt') { circ(g, 0, top - 2.5, 5.2); fillInk(g, col, 1.2); }
      if (hair === 'zopf') { const sw = Math.sin(t * 3) * 1.5; g.beginPath(); g.moveTo(-2.5, hy + 2); g.quadraticCurveTo(sw - 3, hy + 12, sw, hy + 20); g.quadraticCurveTo(sw + 3, hy + 12, 2.5, hy + 2); g.closePath(); fillInk(g, col, 1.1); }
      if (hair === 'afro') { for (let k = 0; k < 8; k++) { const a = Math.PI + (k / 7) * Math.PI; circ(g, Math.cos(a) * (HR + 2), hy - 1 + Math.sin(a) * (HR + 2), 4); g.fillStyle = col; g.fill(); } }
      if (hair === 'wuschel') { spikes(g, col, hy, HR, 9, 4.5); }
      return;
    }
    switch (hair) {
      case 'glatze':
        g.beginPath(); g.ellipse(-3, top + 4, 4.5, 2.2, -0.35, 0, TAU); g.fillStyle = 'rgba(255,255,255,0.5)'; g.fill();
        g.beginPath(); g.ellipse(-HR + 1.2, hy - 1, 1.6, 4, 0, 0, TAU); g.fillStyle = col; g.fill();
        break;
      case 'kurz':
        g.beginPath();
        g.moveTo(-HR - 0.5, hy - 1);
        g.ellipse(0, hy, HR + 0.8, HR * 0.97 + 0.8, 0, Math.PI, 0);
        g.lineTo(HR + 0.5, hy - 3);
        for (let k = 0; k <= 6; k++) g.lineTo(HR - k * 4.2, hy - 6 - ((k % 2) ? 2.5 : 0));
        g.closePath(); fillInk(g, col, 1.3);
        hairShine(g, hy, HR);
        break;
      case 'seitenscheitel':
        g.beginPath();
        g.moveTo(-HR - 0.5, hy);
        g.ellipse(0, hy, HR + 0.8, HR * 0.97 + 0.8, 0, Math.PI, 0);
        g.lineTo(HR + 0.6, hy - 2);
        g.quadraticCurveTo(fx + 4, hy - 9, fx - 2, hy - 6.5);
        g.quadraticCurveTo(-6, hy - 3, -HR - 0.5, hy + 1);
        g.closePath(); fillInk(g, col, 1.3);
        g.beginPath(); g.moveTo(fx + 4, top + 1); g.quadraticCurveTo(fx + 2, hy - 7, fx - 3, hy - 6); inkStroke(g, 0.8);
        hairShine(g, hy, HR);
        break;
      case 'lang':
        g.beginPath();
        g.moveTo(-HR - 1.5, hy + 12);
        g.lineTo(-HR - 1.2, hy);
        g.ellipse(0, hy, HR + 1.2, HR * 0.97 + 1.2, 0, Math.PI, 0);
        g.lineTo(HR + 1.5, hy + 12);
        g.lineTo(HR - 2.5, hy + 12);
        g.quadraticCurveTo(HR - 1, hy - 2, fx + 2, hy - 7);
        g.quadraticCurveTo(-HR + 2, hy - 4, -HR + 2.5, hy + 12);
        g.closePath(); fillInk(g, col, 1.3);
        hairShine(g, hy, HR);
        break;
      case 'locken':
        for (let k = 0; k < 9; k++) { const a = Math.PI + (k / 8) * Math.PI; circ(g, Math.cos(a) * (HR - 0.5), hy - 1 + Math.sin(a) * (HR - 1.5), 4.3); fillInk(g, col, 1); }
        for (let k = 0; k < 4; k++) { circ(g, -6 + k * 4.4, top + 3.5, 3.6); g.fillStyle = sh(col, 0.08); g.fill(); }
        break;
      case 'dutt':
        circ(g, 0, top - 3, 5.5); fillInk(g, col, 1.2);
        g.beginPath(); g.moveTo(-HR - 0.4, hy); g.ellipse(0, hy, HR + 0.6, HR * 0.97 + 0.6, 0, Math.PI, 0); g.lineTo(HR + 0.4, hy - 2);
        g.quadraticCurveTo(fx, hy - 10, -HR - 0.4, hy); g.closePath(); fillInk(g, col, 1.3);
        g.beginPath(); g.moveTo(-3.5, top - 1); g.lineTo(3.5, top - 1); g.lineWidth = 2; g.strokeStyle = '#ec407a'; g.stroke();
        break;
      case 'zopf':
        g.beginPath(); g.moveTo(-HR - 0.4, hy); g.ellipse(0, hy, HR + 0.6, HR * 0.97 + 0.6, 0, Math.PI, 0); g.lineTo(HR + 0.4, hy - 2);
        g.quadraticCurveTo(fx + 2, hy - 9, -HR - 0.4, hy); g.closePath(); fillInk(g, col, 1.3);
        hairShine(g, hy, HR);
        break;
      case 'irokese':
        g.fillStyle = 'rgba(0,0,0,0.12)';
        g.beginPath(); g.ellipse(0, hy - 3, HR - 0.5, HR * 0.8, 0, Math.PI, 0); g.fill();
        g.beginPath(); g.moveTo(-3.5, top + 3);
        for (let k = 0; k < 5; k++) { g.lineTo(-3 + k * 1.8, top - 10 + (k % 2) * 4); g.lineTo(-2 + k * 1.8, top + 1); }
        g.lineTo(5, top + 3); g.closePath(); fillInk(g, col, 1.2);
        break;
      case 'wuschel':
        spikes(g, col, hy, HR, 11, 5);
        g.beginPath(); g.moveTo(-HR - 0.4, hy - 1); g.ellipse(0, hy, HR + 0.7, HR * 0.97 + 0.7, 0, Math.PI, 0); g.lineTo(HR + 0.4, hy - 3);
        for (let k = 0; k <= 7; k++) g.lineTo(HR - k * 3.6, hy - 5 - ((k % 2) ? 3.5 : 0));
        g.closePath(); fillInk(g, col, 1.3);
        break;
      case 'afro':
        for (let k = 0; k < 7; k++) { const a = Math.PI * (1.08 + k * 0.14); circ(g, Math.cos(a) * (HR - 1), hy - 2 + Math.sin(a) * (HR - 2), 4.2); g.fillStyle = col; g.fill(); }
        hairShine(g, hy - 3, HR);
        break;
      default:
        drawHairFront(g, 'kurz', col, hy, HR, back, t, fx);
    }
  }
  function hairShine(g, hy, HR) {
    g.beginPath(); g.ellipse(-4, hy - HR + 3.5, 4.2, 1.6, -0.3, 0, TAU); g.fillStyle = 'rgba(255,255,255,0.22)'; g.fill();
  }
  function spikes(g, col, hy, HR, n, len) {
    g.beginPath();
    for (let k = 0; k <= n; k++) {
      const a = Math.PI + (k / n) * Math.PI;
      const r = (k % 2) ? HR + len : HR;
      const px = Math.cos(a) * r, py = hy + Math.sin(a) * r;
      if (!k) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); fillInk(g, col, 1.1);
  }

  function drawAcc(g, acc, hy, HR, back, t, fx, shY, cloth) {
    const top = hy - HR;
    switch (acc) {
      case 'brille':
        if (back) { g.beginPath(); g.moveTo(-HR, hy - 2); g.lineTo(HR, hy - 2); inkStroke(g, 1); break; }
        g.beginPath(); g.arc(fx - 4.6, hy - 1.2, 4, 0, TAU); g.moveTo(fx + 8.4, hy - 1.2); g.arc(fx + 4.4, hy - 1.2, 4, 0, TAU);
        g.moveTo(fx - 0.6, hy - 1.6); g.lineTo(fx + 0.4, hy - 1.6);
        g.lineWidth = 1.5; g.strokeStyle = '#3b2b1f'; g.stroke();
        g.fillStyle = 'rgba(200,235,255,0.2)'; g.fill();
        break;
      case 'sonnenbrille':
        if (back) { g.beginPath(); g.moveTo(-HR, hy - 2); g.lineTo(HR, hy - 2); inkStroke(g, 1.2); break; }
        rr(g, fx - 9, hy - 4.5, 8, 6, 2.4); fillInk(g, '#111111', 1);
        rr(g, fx + 0.6, hy - 4.5, 8, 6, 2.4); fillInk(g, '#111111', 1);
        g.beginPath(); g.moveTo(fx - 1, hy - 3); g.lineTo(fx + 0.6, hy - 3); inkStroke(g, 1.2);
        g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(fx - 7.5, hy - 3.6, 2.2, 1); g.fillRect(fx + 2.2, hy - 3.6, 2.2, 1);
        break;
      case 'basecap': {
        const c = '#e53935';
        g.beginPath(); g.ellipse(0, hy - 3.5, HR + 1, HR * 0.78, 0, Math.PI, 0); g.closePath(); fillInk(g, c, 1.3);
        if (!back) { g.beginPath(); g.ellipse(fx + 8, hy - 4, 9, 3, 0.08, 0, TAU); fillInk(g, sh(c, -0.18), 1.2); }
        else { g.beginPath(); g.ellipse(-2, hy - 3, 7, 2.4, 0, 0, TAU); fillInk(g, sh(c, -0.18), 1.1); }
        circ(g, 0, top - 0.5, 1.6); fillInk(g, sh(c, 0.2), 0.8);
        g.fillStyle = '#ffffff'; if (!back) { g.beginPath(); g.arc(fx - 1, hy - 9, 2.4, 0, TAU); g.fill(); }
        break;
      }
      case 'bauhelm': {
        const c = '#fdd835';
        g.beginPath(); g.ellipse(0, hy - 4, HR + 1.5, HR * 0.85, 0, Math.PI, 0); g.closePath(); fillInk(g, c, 1.3);
        g.beginPath(); g.ellipse(0, hy - 4, HR + 4, 3.2, 0, 0, TAU); fillInk(g, sh(c, -0.1), 1.2);
        g.beginPath(); g.moveTo(0, top - 2); g.lineTo(0, hy - 6); g.lineWidth = 2.4; g.strokeStyle = sh(c, -0.15); g.stroke();
        g.beginPath(); g.ellipse(-4, hy - 12, 3.5, 1.6, -0.4, 0, TAU); g.fillStyle = 'rgba(255,255,255,0.45)'; g.fill();
        break;
      }
      case 'zylinder':
        g.beginPath(); g.ellipse(0, top + 2, HR + 3, 3.4, 0, 0, TAU); fillInk(g, '#1a1a1a', 1.2);
        rr(g, -8, top - 15, 16, 17, 2); fillInk(g, '#1a1a1a', 1.2);
        g.fillStyle = '#c62828'; g.fillRect(-8, top - 2, 16, 3);
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(-6, top - 13, 2.4, 10);
        break;
      case 'kopfhoerer':
        g.beginPath(); g.arc(0, hy - 1, HR + 2, Math.PI * 1.05, Math.PI * 1.95); g.lineWidth = 3.4; g.strokeStyle = INK; g.stroke();
        g.lineWidth = 2; g.strokeStyle = '#424242'; g.stroke();
        rr(g, -HR - 3.5, hy - 5, 5.5, 9, 2.4); fillInk(g, '#ff4081', 1.1);
        if (back) { rr(g, HR - 2, hy - 5, 5.5, 9, 2.4); fillInk(g, '#ff4081', 1.1); }
        break;
      case 'stirnband':
        g.save(); g.beginPath(); g.ellipse(0, hy, HR + 0.8, HR + 0.8, 0, 0, TAU); g.clip();
        g.fillStyle = '#e53935'; g.fillRect(-HR - 2, hy - 8.5, HR * 2 + 4, 3.6);
        g.fillStyle = '#ffffff'; g.fillRect(-HR - 2, hy - 7.4, HR * 2 + 4, 0.9);
        g.restore();
        g.beginPath(); g.moveTo(-HR, hy - 7); g.lineTo(-HR - 6, hy - 3 + Math.sin(t * 6) * 1.5); g.lineTo(-HR - 4.5, hy - 8); g.closePath(); fillInk(g, '#e53935', 0.9);
        break;
      case 'krone': {
        const c = '#ffca28';
        g.beginPath(); g.moveTo(-8, top + 3); g.lineTo(-9, top - 6); g.lineTo(-4.5, top - 1.5); g.lineTo(0, top - 9); g.lineTo(4.5, top - 1.5); g.lineTo(9, top - 6); g.lineTo(8, top + 3); g.closePath();
        fillInk(g, c, 1.2);
        circ(g, 0, top - 1, 1.6); g.fillStyle = '#e53935'; g.fill();
        circ(g, -5, top + 0.5, 1.2); g.fillStyle = '#29b6f6'; g.fill();
        circ(g, 5, top + 0.5, 1.2); g.fillStyle = '#66bb6a'; g.fill();
        const sp = (t * 2) % 3;
        if (sp < 0.4) { g.fillStyle = '#ffffff'; g.fillRect(6, top - 9, 1, 4); g.fillRect(4.5, top - 7.5, 4, 1); }
        break;
      }
      case 'stethoskop':
        if (back) { g.beginPath(); g.arc(0, shY + 1, 6.5, 0.1, Math.PI - 0.1, true); g.lineWidth = 1.6; g.strokeStyle = '#546e7a'; g.stroke(); break; }
        g.beginPath(); g.moveTo(-5.5, shY + 1); g.quadraticCurveTo(-5, shY + 10, 0, shY + 12); g.quadraticCurveTo(4, shY + 10, 5.5, shY + 1);
        g.lineWidth = 1.8; g.strokeStyle = '#546e7a'; g.stroke();
        circ(g, 0.5, shY + 13.5, 2.2); fillInk(g, '#cfd8dc', 0.9);
        break;
      case 'ausweis':
        g.beginPath(); g.moveTo(-5, shY); g.lineTo(0, shY + 9); g.lineTo(5, shY); g.lineWidth = 1.3; g.strokeStyle = '#1e88e5'; g.stroke();
        if (!back) {
          rr(g, -3.4, shY + 8.5, 7, 8.5, 1.2); fillInk(g, '#ffffff', 0.9);
          g.fillStyle = '#90caf9'; g.fillRect(-2.4, shY + 9.8, 5, 3.6);
          g.fillStyle = '#90a4ae'; g.fillRect(-2.4, shY + 14.4, 5, 1);
        }
        break;
    }
  }

  // =====================================================================
  //  Entities (Spieler, NPCs, Saugroboter) inkl. Slapstick-Effekte
  // =====================================================================

  const FIG = 0.95;   // Figurenmaßstab relativ zu den Iso-Pixeln

  function teamColor(tm) {
    const teams = (R.cat && R.cat.teams) || [{ color: '#3b82f6' }, { color: '#f97316' }];
    return (tm === 0 || tm === 1) && teams[tm] ? teams[tm].color : null;
  }

  /** Bildschirm-Blickrichtung aus Weltwinkel. */
  function screenFacing(d) {
    const cx = Math.cos(d || 0), cy = Math.sin(d || 0);
    const sdx = cx - cy, sdy = cx + cy;
    return { f: sdx >= 0 ? 1 : -1, back: sdy < -0.15 };
  }

  function fxElapsed(id, fx, t) {
    if (!fx) { R.fxStart.delete(id); return 0; }
    const s = R.fxStart.get(id);
    if (!s || s.fx !== fx) { R.fxStart.set(id, { fx, t0: t }); return 0; }
    return t - s.t0;
  }
  function emoAge(id, emo, t) {
    if (!emo) { R.emoStart.delete(id); return -1; }
    const s = R.emoStart.get(id);
    if (!s || s.emo !== emo) { R.emoStart.set(id, { emo, t0: t }); return 0; }
    return t - s.t0;
  }

  function drawRobot(e, t, hl) {
    const x = e.x, y = e.y;
    C = R.ctx; DIM = false; HL = !!hl;
    ell(x + 0.06, y + 0.06, 0, 0.36, 'rgba(20,10,40,0.25)');
    cyl(x, y, 0.02, 0.33, 0.11, '#2f3542', '#4b5563');
    ell(x, y, 0.135, 0.24, sh('#6b7280', 0), true);
    ell(x, y, 0.137, 0.12, sh('#9ca3af', 0), false);
    const blink = (t * 2) % 1 < 0.5;
    const d = e.d || 0;
    const lx = x + Math.cos(d) * 0.2, ly = y + Math.sin(d) * 0.2;
    C.beginPath(); C.arc(isoX(lx, ly), isoY(lx, ly, 0.14), 2.6, 0, TAU);
    C.fillStyle = blink ? '#22d3ee' : '#0e7490'; C.fill();
    if (!DIM && blink) { C.beginPath(); C.arc(isoX(lx, ly), isoY(lx, ly, 0.14), 5, 0, TAU); C.fillStyle = 'rgba(34,211,238,0.25)'; C.fill(); }
    // rotierende Seitenbürste
    const bx = x + Math.cos(d + 0.7) * 0.3, by = y + Math.sin(d + 0.7) * 0.3;
    for (let k = 0; k < 3; k++) {
      const a = t * 18 + k * 2.09;
      C.beginPath(); C.moveTo(isoX(bx, by), isoY(bx, by, 0.03));
      C.lineTo(isoX(bx + Math.cos(a) * 0.12, by + Math.sin(a) * 0.12), isoY(bx + Math.cos(a) * 0.12, by + Math.sin(a) * 0.12, 0.03));
      C.lineWidth = 1.2; C.strokeStyle = '#f59e0b'; C.stroke();
    }
    HL = false;
  }

  /** Zeichnet eine Figur-Entity an Weltposition, sammelt Overlay-Infos. */
  function drawEnt(e, t, view) {
    const g = R.ctx;
    C = g; DIM = false; HL = false;
    if (e.k === 'r') { drawRobot(e, t, view.nearDev !== null && view.nearDev !== undefined && view.nearDev === e.id); return; }
    const npcT = (e.k === 'n' && e.npc && R.cat && R.cat.npcTypes) ? R.cat.npcTypes[e.npc] : null;
    const avatar = e.avatar || (npcT && npcT.look) || {};
    const label = e.label || (npcT && npcT.name) || '';
    const bx = isoX(e.x, e.y), by = isoY(e.x, e.y, 0);
    const sf = screenFacing(e.d);
    const fxName = e.fx || null;
    const el = fxElapsed(e.id, fxName, t);
    const seed = strHash(e.id);
    const moving = !!e.mv && !fxName;
    const o = { f: sf.f, back: sf.back, walk: moving ? t * 11 + seed * 6 : null, pose: 'idle', t, seed };
    if (e.st === 'build' || e.st === 'use' || e.st === 'search') { o.pose = 'work'; o.back = false; }
    const ea = emoAge(e.id, e.emo, t);
    if (ea >= 0 && ea < 1.4 && !fxName && !moving) o.pose = 'wave';
    let ox = 0, oy = 0, rot = 0, scx = 1, scy = 1;
    let over = null;
    switch (fxName) {
      case 'hot': o.skinTint = ['#ff3b2f', 0.55]; o.face = 'hot'; o.pose = 'flail'; oy = -Math.abs(Math.sin(el * 10)) * 7; break;
      case 'yuck': o.skinTint = ['#8bc34a', 0.5]; o.face = 'yuck'; rot = Math.sin(el * 7) * 0.08; break;
      case 'splash': o.clothTint = ['#6d4c41', 0.35]; o.face = 'shock'; rot = -0.12 * o.f; o.pose = 'shield'; break;
      case 'foam': o.face = 'shock'; o.pose = 'flail'; break;
      case 'shake': ox = Math.sin(el * 70) * 2.4; o.face = 'shock'; o.pose = 'flail'; break;
      case 'launch':
        if (el < 0.9) { const k = el / 0.9; oy = -Math.sin(k * Math.PI) * 44; rot = k * TAU * o.f; o.face = 'shock'; o.pose = 'flail'; }
        else o.face = 'dizzy';
        break;
      case 'bonk': o.face = 'dizzy'; rot = Math.sin(el * 4) * 0.06; break;
      case 'wet': o.clothTint = ['#2a6fdb', 0.28]; o.face = 'squint'; break;
      case 'sticky': o.face = 'shock'; o.pose = 'flail'; rot = Math.sin(el * 5) * 0.1; break;
      case 'tangle': o.face = 'shock'; rot = Math.sin(el * 3) * 0.08; break;
      case 'spin': scx = Math.cos(el * 16); o.face = 'dizzy'; o.pose = 'flail'; break;
      case 'slip': {
        const k = Math.min(1, el / 0.3);
        rot = -k * 1.35 * o.f + (k >= 1 ? Math.sin(el * 6) * 0.05 : 0);
        o.face = 'shock'; o.pose = 'flail';
        break;
      }
      case 'confetti': o.face = el < 0.6 ? 'shock' : 'happy'; o.pose = el < 0.6 ? 'shield' : 'cheer'; break;
      case 'mummy': o.mummy = true; o.pose = 'zombie'; o.walk = t * 4; rot = Math.sin(el * 2) * 0.05; break;
      case 'paint': o.face = 'squint'; break;
      case 'soot': o.skinTint = ['#1f1f1f', 0.82]; o.clothTint = ['#2b2b2b', 0.55]; o.face = 'sooty'; break;
      case 'squash': {
        const rem = (e.fxT !== undefined && e.fxT !== null) ? e.fxT : 2;
        let k = el < 0.15 ? el / 0.15 : 1;
        if (rem < 0.35) k = Math.max(0, rem / 0.35);
        scy = 1 - 0.62 * k + Math.sin(el * 12) * 0.03 * k; scx = 1 + 0.55 * k;
        o.face = 'dizzy';
        break;
      }
      case 'toot': o.face = 'squint'; oy = -Math.abs(Math.sin(el * 6)) * 3; break;
    }

    // Schatten
    const shadowR = 0.3 * (fxName === 'launch' && el < 0.9 ? 0.7 : 1) * (scx > 1 ? scx * 0.8 : 1);
    ell(e.x, e.y, 0, shadowR, 'rgba(20,10,40,0.26)');
    const tc = teamColor(e.tm);
    if (tc && e.k === 'p') {
      C.beginPath(); C.ellipse(bx, by, 0.36 * ERX, 0.36 * ERY, 0, 0, TAU);
      C.lineWidth = 2.2; C.strokeStyle = rgba(tc, 0.85); C.stroke();
    }
    if (e.isMe) {
      C.beginPath(); C.ellipse(bx, by, 0.42 * ERX, 0.42 * ERY, 0, 0, TAU);
      C.lineWidth = 1.6; C.strokeStyle = 'rgba(255,216,74,' + (0.55 + 0.25 * Math.sin(t * 4)) + ')'; C.stroke();
    }
    // Boden-Effekte unter der Figur
    if (fxName === 'wet' || fxName === 'sticky' || fxName === 'slip' || fxName === 'foam' || fxName === 'paint') groundFx(e, fxName, el, t);

    g.save();
    g.translate(bx + ox, by + oy);
    if (rot) g.rotate(rot);
    g.scale(FIG * scx, FIG * scy);
    if (e.ghost) g.globalAlpha *= 0.55;
    drawFigure(g, avatar, o);
    bodyFx(g, fxName, el, t, o, seed);
    g.restore();
    C = g;

    // Overlay-Daten (Bildschirmkoordinaten)
    const headY = by + oy - 66 * FIG * (scy < 1 ? scy + 0.15 : 1);
    R.ovl.push({
      e, x: bx + ox, y: headY, feetY: by, name: e.k === 'p' ? (e.name || '') : '', label: e.k === 'n' ? label : '',
      team: tc, isMe: !!e.isMe, need: e.need || null, slow: !!e.slow, needFrac: e.needFrac, emo: e.emo || null, emoAge: ea,
      st: e.st, p: e.p, dg: !!e.dg, fx: fxName, el
    });
  }

  function groundFx(e, fx, el, t) {
    const x = e.x, y = e.y;
    if (fx === 'wet') { ell(x + 0.05, y + 0.05, 0, Math.min(0.55, 0.2 + el * 0.4), 'rgba(80,160,255,0.35)'); ell(x, y, 0, Math.min(0.35, 0.1 + el * 0.3), 'rgba(160,215,255,0.35)'); }
    if (fx === 'sticky') { ell(x, y, 0, 0.42, 'rgba(170,200,40,0.55)'); ell(x - 0.1, y + 0.05, 0, 0.2, 'rgba(220,240,120,0.6)'); }
    if (fx === 'slip') {
      for (let k = 0; k < 5; k++) {
        const a = k * 1.3 + 0.4, r = 0.35 + hash(k, 1, 7) * 0.3;
        const px = isoX(x + Math.cos(a) * r, y + Math.sin(a) * r), py = isoY(x + Math.cos(a) * r, y + Math.sin(a) * r, 0);
        C.save(); C.translate(px, py); C.rotate(a);
        rr(C, -5, -2, 10, 4, 1.5); C.fillStyle = k % 2 ? '#6d3a1e' : '#ffd54f'; C.fill(); inkStroke(C, 0.8);
        C.restore();
      }
    }
    if (fx === 'foam') ell(x, y, 0, 0.55, 'rgba(255,255,255,0.7)');
    if (fx === 'paint') {
      const cols = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#a855f7'];
      for (let k = 0; k < 6; k++) { const a = k * 1.05; ell(x + Math.cos(a) * 0.28, y + Math.sin(a) * 0.28, 0, 0.13, cols[k] + 'cc'); }
    }
  }

  /** Effekte im Figuren-Koordinatensystem (Füße = 0, nach oben negativ). */
  function bodyFx(g, fx, el, t, o, seed) {
    if (!fx) return;
    const HY = -44;
    switch (fx) {
      case 'hot': {
        for (let k = 0; k < 8; k++) {
          const side = k % 2 ? 1 : -1;
          const ph = (el * 1.8 + k / 8) % 1;
          circ(g, side * (14 + ph * 7), HY - ph * 22, 2.2 + ph * 4.5);
          g.fillStyle = 'rgba(255,255,255,' + (0.85 * (1 - ph)) + ')'; g.fill();
        }
        g.font = '700 12px ' + FONT; g.fillStyle = '#ff3b2f'; g.textAlign = 'center';
        if ((el * 4) % 2 < 1) g.fillText('!!', 16, HY - 18);
        break;
      }
      case 'yuck':
        for (let k = 0; k < 3; k++) {
          g.beginPath();
          const x0 = -8 + k * 8, ph = (el * 1.2 + k * 0.3) % 1;
          for (let s = 0; s <= 10; s++) { const yy = HY - 16 - s * 1.6 - ph * 6; const xx = x0 + Math.sin(s * 0.9 + el * 6) * 2; if (!s) g.moveTo(xx, yy); else g.lineTo(xx, yy); }
          g.lineWidth = 1.6; g.strokeStyle = 'rgba(120,180,40,' + (0.9 - ph * 0.6) + ')'; g.stroke();
        }
        break;
      case 'splash':
        for (let k = 0; k < 6; k++) {
          circ(g, -7 + hash(k, 2, seed * 99) * 14, -32 + hash(k, 5, 3) * 26, 1.8 + hash(k, 8, 1) * 2.4);
          g.fillStyle = 'rgba(109,76,65,0.9)'; g.fill();
        }
        for (let k = 0; k < 5; k++) {
          const ph = (el * 1.5 + k / 5) % 1;
          circ(g, -10 + k * 5, -40 + ph * 40, 1.6); g.fillStyle = 'rgba(109,76,65,' + (1 - ph) + ')'; g.fill();
        }
        break;
      case 'foam': {
        const grow = Math.min(1, el * 3);
        const top = -6 - 26 * grow;
        const blobs = [[-11, -4, 8], [11, -4, 8], [0, -6, 10], [-7, -14, 8], [7, -14, 8], [0, -20, 8], [-12, -18, 6], [12, -19, 6], [-4, -26, 6], [5, -27, 6]];
        for (const [bx, by, r] of blobs) {
          const yy = by * grow + 2;
          if (yy < top - 4) continue;
          circ(g, bx * (0.6 + grow * 0.4), yy, r * (0.5 + grow * 0.5)); fillInk(g, '#ffffff', 1);
        }
        for (const [bx, by, r] of blobs) { circ(g, bx * (0.6 + grow * 0.4) - r * 0.3, by * grow + 2 - r * 0.3, r * 0.3); g.fillStyle = '#e3f2fd'; g.fill(); }
        for (let k = 0; k < 6; k++) {
          const ph = (el * 0.9 + k / 6) % 1;
          circ(g, -12 + k * 5 + Math.sin(el * 3 + k) * 3, -20 - ph * 34, 1.8 + k % 3);
          g.lineWidth = 1; g.strokeStyle = 'rgba(120,180,255,' + (1 - ph) + ')'; g.stroke();
        }
        break;
      }
      case 'shake':
        for (const side of [-1, 1]) {
          g.beginPath();
          for (let s = 0; s < 6; s++) g.lineTo(side * (15 + (s % 2) * 4), -40 + s * 5);
          g.lineWidth = 1.6; g.strokeStyle = '#ffb300'; g.stroke();
        }
        break;
      case 'launch':
        if (el < 0.9) {
          for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(-14 + k * 9, 6); g.lineTo(-14 + k * 9, 20); g.lineWidth = 1.4; g.strokeStyle = 'rgba(255,255,255,0.7)'; g.stroke(); }
        } else starsAround(g, el, HY - 10, 14, '#ffd54f');
        break;
      case 'bonk': {
        g.beginPath(); g.ellipse(2, HY - 13, 4.5, 4, 0, Math.PI, 0); fillInk(g, '#ff8fa3', 1);
        g.beginPath(); g.ellipse(1, HY - 15, 1.5, 0.9, 0, 0, TAU); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fill();
        for (let k = 0; k < 3; k++) {
          const a = el * 5 + k * 2.09;
          const bx = Math.cos(a) * 15, by = HY - 16 + Math.sin(a) * 5;
          bird(g, bx, by, el * 20 + k);
        }
        break;
      }
      case 'wet':
        if (el < 0.6) { g.fillStyle = 'rgba(80,160,255,0.55)'; g.fillRect(-9, -120, 18, 120 - 40 + el * 40); }
        for (let k = 0; k < 9; k++) {
          const ph = (el * 1.4 + hash(k, 3, 3)) % 1;
          const x0 = -13 + hash(k, 9, 2) * 26;
          g.beginPath(); g.moveTo(x0, -52 + ph * 52); g.quadraticCurveTo(x0 + 1.8, -48 + ph * 52, x0, -46 + ph * 52); g.quadraticCurveTo(x0 - 1.8, -48 + ph * 52, x0, -52 + ph * 52);
          g.fillStyle = 'rgba(80,170,255,' + (0.95 - ph * 0.5) + ')'; g.fill();
        }
        break;
      case 'sticky':
        for (const sx of [-5, 5]) {
          g.beginPath(); g.moveTo(sx, -1); g.quadraticCurveTo(sx + Math.sin(el * 4) * 4, 3, sx * 2.2, 5);
          g.lineWidth = 2.2; g.strokeStyle = 'rgba(190,215,60,0.95)'; g.stroke();
        }
        g.beginPath(); g.moveTo(-14, -20); g.quadraticCurveTo(-16, -8, -12, 3); g.lineWidth = 1.6; g.strokeStyle = 'rgba(190,215,60,0.85)'; g.stroke();
        g.beginPath(); g.moveTo(14, -22); g.quadraticCurveTo(17, -9, 12, 3); g.stroke();
        break;
      case 'tangle':
        for (let k = 0; k < 4; k++) {
          g.beginPath(); g.moveTo(-14, -48 + k * 11); g.lineTo(14, -42 + k * 11);
          g.lineWidth = 5.6; g.strokeStyle = INK; g.stroke();
          g.lineWidth = 4; g.strokeStyle = k % 2 ? '#ffffff' : '#f3f0e6'; g.stroke();
        }
        g.beginPath(); g.moveTo(14, -30);
        g.bezierCurveTo(28, -40 + Math.sin(el * 5) * 6, 26, -8, 16 + Math.sin(el * 4) * 4, 2);
        g.lineWidth = 3.6; g.strokeStyle = '#ffffff'; g.stroke();
        break;
      case 'spin':
        starsAround(g, el, HY - 14, 13, '#ffeb3b');
        break;
      case 'slip':
        for (let k = 0; k < 3; k++) { g.beginPath(); g.moveTo(-18 - k * 4, -10 - k * 6); g.lineTo(-26 - k * 4, -12 - k * 6); g.lineWidth = 1.4; g.strokeStyle = 'rgba(255,255,255,0.75)'; g.stroke(); }
        break;
      case 'confetti': {
        const cols = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
        for (let k = 0; k < 22; k++) {
          const ph = (el * 0.7 + hash(k, 1, 1)) % 1;
          const x0 = -22 + hash(k, 2, 2) * 44 + Math.sin(el * 3 + k) * 4;
          const y0 = -78 + ph * 80;
          g.save(); g.translate(x0, y0); g.rotate(el * 6 + k);
          g.fillStyle = cols[k % cols.length]; g.fillRect(-1.8, -1, 3.6, 2.2);
          g.restore();
        }
        if (el < 0.5) { g.font = '700 13px ' + FONT; g.textAlign = 'center'; g.fillStyle = '#ec4899'; g.fillText('PENG!', 0, HY - 22 - el * 20); }
        break;
      }
      case 'mummy': {
        g.beginPath(); g.moveTo(-8, HY - 6);
        g.bezierCurveTo(-18, HY - 4 + Math.sin(el * 5) * 4, -22, HY + 6, -26 + Math.sin(el * 4) * 3, HY + 12);
        g.lineWidth = 4.4; g.strokeStyle = INK; g.stroke();
        g.lineWidth = 3; g.strokeStyle = '#efe7d6'; g.stroke();
        break;
      }
      case 'paint': {
        const cols = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#a855f7'];
        for (let k = 0; k < 6; k++) {
          const x0 = -10 + k * 4, y0 = -56 + (k % 3) * 3;
          g.beginPath(); g.ellipse(x0, y0, 4.5, 3.5, 0, 0, TAU); g.fillStyle = cols[k]; g.fill();
          const len = 10 + hash(k, seed * 10, 4) * 18 + Math.min(10, el * 8);
          rr(g, x0 - 1.2, y0, 2.4, len, 1.2); g.fill();
          circ(g, x0, y0 + len, 1.8); g.fill();
        }
        for (let k = 0; k < 5; k++) { circ(g, -8 + k * 4.5, -30 + (k % 2) * 6, 2.4); g.fillStyle = cols[(k + 2) % 6]; g.fill(); }
        break;
      }
      case 'soot': {
        for (let k = 0; k < 6; k++) {
          const ph = (el * 0.8 + k / 6) % 1;
          circ(g, -6 + k * 2.5 + Math.sin(el * 2 + k) * 4, HY - 16 - ph * 26, 3 + ph * 6);
          g.fillStyle = 'rgba(60,60,60,' + (0.6 * (1 - ph)) + ')'; g.fill();
        }
        g.beginPath();
        for (let k = 0; k <= 10; k++) { const a = Math.PI + k / 10 * Math.PI; const r = (k % 2) ? 18 : 12; g.lineTo(Math.cos(a) * r, HY - 2 + Math.sin(a) * r); }
        g.lineWidth = 1.2; g.strokeStyle = '#3a3a3a'; g.stroke();
        break;
      }
      case 'squash':
        for (const side of [-1, 1]) {
          circ(g, side * (20 + Math.min(1, el * 3) * 6), -3, 4 + Math.min(1, el * 3) * 3);
          g.fillStyle = 'rgba(200,190,180,' + Math.max(0, 0.7 - el * 0.4) + ')'; g.fill();
        }
        break;
      case 'toot':
        for (let k = 0; k < 4; k++) {
          const ph = (el * 0.8 + k / 4) % 1;
          circ(g, -14 - ph * 14, -14 - ph * 10 + Math.sin(el * 4 + k) * 2, 3 + ph * 6);
          g.fillStyle = 'rgba(150,200,90,' + (0.7 * (1 - ph)) + ')'; g.fill();
        }
        g.font = '700 12px ' + FONT; g.fillStyle = '#6b8e23'; g.textAlign = 'center';
        g.fillText('♪', -20, -34 - Math.sin(el * 3) * 4);
        break;
    }
  }
  function starsAround(g, el, cy, r, col) {
    for (let k = 0; k < 4; k++) {
      const a = el * 5 + k * (TAU / 4);
      star(g, Math.cos(a) * r, cy + Math.sin(a) * r * 0.35, 3.4, col);
    }
  }
  function star(g, x, y, r, col) {
    g.beginPath();
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5; const rr2 = k % 2 ? r * 0.45 : r; g.lineTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2); }
    g.closePath(); fillInk(g, col, 0.8);
  }
  function bird(g, x, y, ph) {
    g.beginPath(); g.ellipse(x, y, 3.2, 2.4, 0, 0, TAU); fillInk(g, '#ffd54f', 0.8);
    const w = Math.sin(ph) * 2.5;
    g.beginPath(); g.moveTo(x - 1, y - 1); g.lineTo(x - 4, y - 3 - w); g.lineTo(x + 1, y - 1.5); g.closePath(); fillInk(g, '#ffca28', 0.7);
    g.beginPath(); g.moveTo(x + 3, y); g.lineTo(x + 5, y + 0.6); g.lineTo(x + 3, y + 1.2); g.closePath(); g.fillStyle = '#ff7043'; g.fill();
  }

  // =====================================================================
  //  Partikel & schwebende Texte
  // =====================================================================
  const RAINBOW = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
  function spawn(p) { if (R.parts.length < 700) R.parts.push(p); }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function burst(kind, x, y, opts) {
    opts = opts || {};
    const n = opts.n || 1;
    const P = (type, col, count, sp, up, life, size, extra) => {
      for (let i = 0; i < Math.round(count * n); i++) {
        const a = Math.random() * TAU, s = rnd(sp * 0.3, sp);
        spawn(Object.assign({ type, col, x: x + rnd(-0.1, 0.1), y: y + rnd(-0.1, 0.1), z: opts.z !== undefined ? opts.z : 0.9,
          vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rnd(up * 0.5, up), life: rnd(life * 0.7, life), max: life, size: rnd(size * 0.7, size),
          rot: Math.random() * TAU, vr: rnd(-8, 8), g: 9 }, extra || {}));
      }
    };
    switch (kind) {
      case 'confetti': P('rect', null, 40, 2.6, 5, 1.8, 3.4, { g: 4, drag: 1.4 }); break;
      case 'hot': P('spark', '#ff7043', 14, 2, 3, 0.7, 2.2); P('smoke', '#ffffff', 8, 0.6, 1.2, 1.1, 5, { g: -1 }); break;
      case 'yuck': P('drop', '#8bc34a', 14, 1.8, 3, 0.9, 2.4); break;
      case 'splash': P('drop', '#6d4c41', 22, 2.4, 3.5, 0.9, 2.6); break;
      case 'foam': P('bubble', '#ffffff', 26, 1.4, 2.5, 1.6, 4.5, { g: -0.6, drag: 1.5 }); break;
      case 'shake': P('spark', '#ffd54f', 12, 2.4, 2, 0.5, 2); break;
      case 'launch': P('smoke', '#e0e0e0', 12, 1.6, 0.6, 0.9, 6, { g: -0.5, z: 0.1 }); P('star', '#ffd54f', 6, 2, 3, 0.9, 4); break;
      case 'bonk': case 'stars': P('star', '#ffd54f', 9, 2, 3.5, 0.9, 4); break;
      case 'wet': P('drop', '#4fa8ff', 26, 2.2, 4, 0.9, 2.4); break;
      case 'sticky': P('drop', '#b5d33c', 16, 1.6, 2.6, 0.9, 2.8); break;
      case 'tangle': P('strip', '#ffffff', 10, 2, 3, 1.2, 6); break;
      case 'spin': P('star', '#ffeb3b', 8, 2.4, 2.4, 0.8, 3.6); break;
      case 'slip': P('rect', '#6d3a1e', 14, 2.4, 2.4, 1, 3.2); P('spark', '#ffffff', 6, 2, 2, 0.4, 2); break;
      case 'mummy': P('strip', '#efe7d6', 12, 1.8, 3, 1.3, 7); break;
      case 'paint': P('drop', null, 30, 2.6, 4, 1, 3); break;
      case 'soot': P('smoke', '#333333', 16, 1.2, 1.5, 1.4, 7, { g: -0.8 }); break;
      case 'squash': P('smoke', '#cfc6bb', 12, 2.2, 0.4, 0.8, 5, { z: 0.05, g: 0 }); break;
      case 'toot': P('smoke', '#9ccc65', 10, 1, 1, 1.4, 6, { g: -0.6, z: 0.4 }); break;
      case 'pop': P('ring', '#ffffff', 1, 0, 0, 0.45, 2); P('spark', '#ffffff', 8, 2, 2, 0.4, 2); break;
      case 'alarm': P('ring', '#ef4444', 3, 0, 0, 0.9, 2, { stagger: true }); P('text', '#ef4444', 1, 0, 1.6, 1, 14, { text: '!' }); break;
      case 'pickup': P('sparkle', '#fff59d', 14, 1.4, 2.5, 0.9, 3.2, { g: 1 }); break;
      case 'sparkle': P('sparkle', '#ffffff', 10, 1.2, 2, 0.8, 3, { g: 1 }); break;
      case 'build': P('spark', '#ffca28', 8, 1.6, 2, 0.4, 1.8, { z: 0.6 }); break;
      case 'coins': P('coin', '#ffca28', 16, 1.6, 5, 1.2, 4); break;
      case 'smoke': P('smoke', '#bdbdbd', 10, 0.8, 1, 1.3, 6, { g: -0.6 }); break;
      case 'hearts': P('heart', '#ff4d6d', 8, 1.2, 3, 1.3, 5, { g: 1.2 }); break;
      default: P('spark', '#ffffff', 10, 2, 2, 0.6, 2.2);
    }
  }

  function floatText(text, x, y, color) {
    R.floats.push({ text: String(text), x, y, col: color || '#ffffff', t0: R.t, life: 1.5 });
    if (R.floats.length > 40) R.floats.shift();
  }

  function updateParts(dt) {
    const ps = R.parts;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      const drag = p.drag || 0;
      if (drag) { const f = Math.exp(-drag * dt); p.vx *= f; p.vy *= f; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vz -= p.g * dt; p.z += p.vz * dt;
      if (p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.6; p.vy *= 0.6; }
      p.rot += p.vr * dt;
      ps[w++] = p;
    }
    ps.length = w;
  }

  function drawParts() {
    const g = R.ctx;
    for (const p of R.parts) {
      const a = clamp(p.life / p.max, 0, 1);
      const px = isoX(p.x, p.y), py = isoY(p.x, p.y, p.z);
      g.globalAlpha = Math.min(1, a * 1.6);
      switch (p.type) {
        case 'rect': {
          g.save(); g.translate(px, py); g.rotate(p.rot); g.scale(1, Math.cos(p.rot * 1.7));
          g.fillStyle = p.col || RAINBOW[(p.size * 100 | 0) % RAINBOW.length]; g.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
          g.restore(); break;
        }
        case 'drop': circ(g, px, py, p.size * (0.6 + a * 0.4)); g.fillStyle = p.col || RAINBOW[(p.rot * 10 | 0) % RAINBOW.length]; g.fill(); break;
        case 'spark': circ(g, px, py, p.size * a); g.fillStyle = p.col; g.fill(); break;
        case 'smoke': circ(g, px, py, p.size * (1.6 - a)); g.fillStyle = p.col; g.globalAlpha = a * 0.55; g.fill(); break;
        case 'bubble': circ(g, px, py, p.size); g.lineWidth = 1; g.strokeStyle = 'rgba(140,190,255,0.9)'; g.stroke(); g.fillStyle = 'rgba(255,255,255,0.6)'; g.fill(); break;
        case 'star': star(g, px, py, p.size, p.col); break;
        case 'strip': g.save(); g.translate(px, py); g.rotate(p.rot); g.fillStyle = p.col; g.fillRect(-p.size, -1.2, p.size * 2, 2.4); g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.6; g.strokeRect(-p.size, -1.2, p.size * 2, 2.4); g.restore(); break;
        case 'ring': {
          const k = 1 - a;
          g.beginPath(); g.ellipse(px, isoY(p.x, p.y, 0), 4 + k * 46, 2 + k * 23, 0, 0, TAU);
          g.lineWidth = 2.5 * a + 0.5; g.strokeStyle = p.col; g.stroke(); break;
        }
        case 'sparkle': {
          g.fillStyle = p.col;
          g.fillRect(px - p.size, py - 0.6, p.size * 2, 1.2); g.fillRect(px - 0.6, py - p.size, 1.2, p.size * 2); break;
        }
        case 'coin': g.beginPath(); g.ellipse(px, py, p.size * Math.abs(Math.cos(p.rot)) + 0.6, p.size, 0, 0, TAU); g.fillStyle = '#ffca28'; g.fill(); g.lineWidth = 0.8; g.strokeStyle = '#b8860b'; g.stroke(); break;
        case 'heart': {
          const s = p.size / 4;
          g.beginPath(); g.moveTo(px, py + 2 * s); g.bezierCurveTo(px - 4 * s, py - 1 * s, px - 2 * s, py - 4 * s, px, py - 2 * s); g.bezierCurveTo(px + 2 * s, py - 4 * s, px + 4 * s, py - 1 * s, px, py + 2 * s);
          g.fillStyle = p.col; g.fill(); break;
        }
        case 'text': g.font = '800 ' + p.size + 'px ' + FONT; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = '#ffffff'; g.strokeText(p.text, px, py); g.fillStyle = p.col; g.fillText(p.text, px, py); break;
      }
    }
    g.globalAlpha = 1;
  }

  // =====================================================================
  //  Frame: Kamera, Zeichenreihenfolge, Overlays, Minimap, API
  // =====================================================================

  function init(canvas) {
    R.canvas = canvas;
    R.ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    resize();
  }

  function resize() {
    const cv = R.canvas;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const w = Math.max(1, rect.width || cv.clientWidth || window.innerWidth);
    const h = Math.max(1, rect.height || cv.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    R.cw = w; R.ch = h; R.dpr = dpr;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    // Basis-Zoom: Handy hochkant ~6–7 Kacheln (große Figuren), Desktop ~15–20 Kacheln Breite
    let n;
    if (w < 500) n = 6.4;
    else if (w < 700) n = 6.4 + (w - 500) / 200 * 2.6;
    else if (w < 1100) n = 9 + (w - 700) / 400 * 6;
    else n = 15 + Math.min(5, (w - 1100) / 300 * 5);
    let s = w / (HW * 2 * n);
    s = Math.min(s, h / (HH * 2 * 5.6));
    R.baseScale = s;
    R.vign = null; R.bgGrad = null;
  }

  function effScale(zoom) {
    return R.baseScale * clamp(zoom || 1, 0.45, 2.6);
  }

  function ensureFloor() {
    if (!R.map) return;
    const want = R.scale * R.dpr;
    const f = R.floor;
    if (!f) { R.floor = buildFloor(Math.min(want, 3.2)); R.floorBuiltAt = R.t; return; }
    const ratio = Math.min(want, 3.2) / f.wantCs;
    // erst neu aufbauen, wenn der Zoom kurz stillsteht (kein Ruckeln beim Pinch/Mausrad)
    if ((ratio > 1.25 || ratio < 0.6) && R.t - R.zoomChangedAt > 0.25 && R.t - R.floorBuiltAt > 0.35) {
      R.floor = buildFloor(Math.min(want, 3.2));
      R.floorBuiltAt = R.t;
    }
  }

  function background(g) {
    const key = R.cw + 'x' + R.ch;
    if (!R.bgGrad || R.bgKey !== key) {
      const gr = g.createLinearGradient(0, 0, 0, R.ch * R.dpr);
      gr.addColorStop(0, '#1d2347');
      gr.addColorStop(1, '#3b2c63');
      R.bgGrad = gr; R.bgKey = key;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = R.bgGrad;
    g.fillRect(0, 0, R.canvas.width, R.canvas.height);
  }

  function groundPlane(g) {
    const m = R.map, b = bld();
    const pad = 22;
    C = g; DIM = false;
    g.beginPath(); mv(-pad, -pad, 0); ln(m.w + pad, -pad, 0); ln(m.w + pad, m.h + pad, 0); ln(-pad, m.h + pad, 0); g.closePath();
    g.fillStyle = b.outside; g.fill();
    if (!R.groundPat || R.groundPatCol !== b.outside) {
      const pc = document.createElement('canvas'); pc.width = 64; pc.height = 32;
      const pg = pc.getContext('2d');
      for (let k = 0; k < 26; k++) {
        pg.fillStyle = k % 2 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
        pg.fillRect(hash(k, 1, 1) * 64, hash(k, 2, 2) * 32, 1.5, 3);
      }
      R.groundPat = g.createPattern(pc, 'repeat'); R.groundPatCol = b.outside;
    }
    if (R.groundPat) { g.fillStyle = R.groundPat; g.fill(); }
    // Gehweg-Rand um das Gebäude
    g.beginPath(); mv(-0.6, -0.6, 0); ln(m.w + 0.6, -0.6, 0); ln(m.w + 0.6, m.h + 0.6, 0); ln(-0.6, m.h + 0.6, 0); g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fill();
  }

  function waterAnim(g, t, vx0, vx1, vy0, vy1) {
    if (!R.waterList.length) return;
    g.save();
    g.transform(HW, HH, -HW, HH, 0, 0);
    for (const w of R.waterList) {
      const ax = isoX(w.x + 0.5, w.y + 0.5), ay = isoY(w.x + 0.5, w.y + 0.5, 0);
      if (ax < vx0 - 40 || ax > vx1 + 40 || ay < vy0 - 40 || ay > vy1 + 40) continue;
      const dim = R.map && !isBright([roomAt(w.x, w.y)]);
      const a = 0.12 + 0.1 * Math.sin(t * 1.7 + w.x * 0.9 + w.y * 1.3);
      g.fillStyle = 'rgba(180,235,255,' + (dim ? a * 0.4 : a) + ')';
      g.fillRect(w.x, w.y, 1, 1);
      if (!dim) {
        g.fillStyle = 'rgba(255,255,255,0.45)';
        for (let k = 0; k < 2; k++) {
          const ph = (t * 0.25 + hash(w.x, w.y, k)) % 1;
          g.fillRect(w.x + 0.2 + ph * 0.6, w.y + 0.25 + k * 0.4 + Math.sin(t * 2 + k) * 0.04, 0.22, 0.03);
        }
      }
    }
    g.restore();
  }

  function fogOverlay(g) {
    const m = R.map;
    g.save();
    g.transform(HW, HH, -HW, HH, 0, 0);
    g.fillStyle = 'rgba(14,18,44,' + FOGA + ')';
    for (const r of m.rooms) if (!R.bright.has(r.id)) g.fillRect(r.x, r.y, r.w, r.h);
    for (const d of m.doors) if (!R.bright.has(d.a) && !R.bright.has(d.b)) g.fillRect(d.x, d.y, 1, 1);
    g.restore();
  }

  function cssPos(ix, iy) { return [(ix * R.k + R.tx) / R.dpr, (iy * R.k + R.ty) / R.dpr]; }

  /** Haupt-Zeichenfunktion. */
  function frame(view) {
    const g = R.ctx;
    if (!g) return;
    view = view || {};
    const now = (view.t !== undefined && view.t !== null) ? view.t : performance.now() / 1000;
    let dt = (view.dt !== undefined && view.dt !== null) ? view.dt : (R.lastT === null ? 1 / 60 : now - R.lastT);
    dt = clamp(dt || 0, 0, 0.1);
    R.lastT = now; R.t = now; R.dt = dt;
    if (!R.canvas.width || R.canvas.width !== Math.round(R.cw * R.dpr)) resize();
    background(g);
    updateParts(dt);
    if (!R.map) { drawOverlayLayer(g, view); return; }

    const z = view.zoom || 1;
    if (z !== R.zoom) { R.zoom = z; R.zoomChangedAt = now; }
    R.scale = effScale(R.zoom);
    ensureFloor();

    // ---- Eigene Position & Kamera ----
    const me = view.me || null;
    const mp = view.mePos || (me ? { x: me.x, y: me.y } : null);
    R.haveMe = !!mp && !view.spectator;
    if (mp) { R.meX = mp.x; R.meY = mp.y; }
    const target = view.cam || mp || R.mapCenter;
    if (!R.camInit || Math.hypot(target.x - R.camX, target.y - R.camY) > 14) { R.camX = target.x; R.camY = target.y; R.camInit = true; }
    else { const kc = 1 - Math.exp(-dt * 9); R.camX += (target.x - R.camX) * kc; R.camY += (target.y - R.camY) * kc; }
    // Kamerawackeln
    if (R.shakeAmp > 0.05) { R.shakeX = (Math.random() * 2 - 1) * R.shakeAmp; R.shakeY = (Math.random() * 2 - 1) * R.shakeAmp; R.shakeAmp *= Math.exp(-dt * 7); }
    else { R.shakeX = R.shakeY = 0; R.shakeAmp = 0; }
    const k = R.scale * R.dpr;
    const camIX = isoX(R.camX, R.camY), camIY = isoY(R.camX, R.camY, 0) - 22;
    R.k = k;
    R.tx = R.canvas.width / 2 - camIX * k + R.shakeX * R.dpr;
    R.ty = R.canvas.height / 2 - camIY * k + R.shakeY * R.dpr;
    g.setTransform(k, 0, 0, k, R.tx, R.ty);
    C = g; DIM = false; HL = false;
    g.lineJoin = 'round'; g.lineCap = 'round';

    // sichtbarer Iso-Bereich
    const vx0 = -R.tx / k, vx1 = (R.canvas.width - R.tx) / k, vy0 = -R.ty / k, vy1 = (R.canvas.height - R.ty) / k;

    computeBright(view);

    // ---- Boden ----
    groundPlane(g);
    const f = R.floor;
    if (f) {
      // nur den sichtbaren Ausschnitt des Boden-Caches zeichnen
      let sx0 = (vx0 + f.ox) * f.cs, sy0 = (vy0 + f.oy) * f.cs, sx1 = (vx1 + f.ox) * f.cs, sy1 = (vy1 + f.oy) * f.cs;
      sx0 = clamp(Math.floor(sx0), 0, f.canvas.width); sy0 = clamp(Math.floor(sy0), 0, f.canvas.height);
      sx1 = clamp(Math.ceil(sx1), 0, f.canvas.width); sy1 = clamp(Math.ceil(sy1), 0, f.canvas.height);
      if (sx1 - sx0 > 1 && sy1 - sy0 > 1) {
        g.drawImage(f.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0 / f.cs - f.ox, sy0 / f.cs - f.oy, (sx1 - sx0) / f.cs, (sy1 - sy0) / f.cs);
      }
    }
    waterAnim(g, now, vx0, vx1, vy0, vy1);
    if (view.fog !== false && !view.spectator && R.brightKey !== 'all') fogOverlay(g);
    floorMarks(g, view, now);

    // ---- Wandhöhen (Cutaway der Vorderwände im aktuellen Raum) ----
    const fogOn = view.fog !== false && !view.spectator && R.haveMe;
    const kh = 1 - Math.exp(-dt * 10);
    for (const o of R.statics) {
      if (o.k !== 'wall') continue;
      let low = false;
      if (fogOn) for (const r of o.front) if (R.bright.has(r)) { low = true; break; }
      const base = o.hedge ? 0.5 : WALL_H;
      o.ht = low ? (o.hedge ? 0.2 : 0.16) : base;
      o.h += (o.ht - o.h) * kh;
    }

    // ---- Entities vorbereiten ----
    const ents = [];
    R.ovl.length = 0;
    const list = view.ents || [];
    for (const e of list) {
      if (e.k === 'r') { const rp = R.robotPos.get(e.id); if (rp) { rp.x = e.x; rp.y = e.y; rp.d = e.d; rp.seen = true; } }
      ents.push(e);
    }
    if (me && mp && !isHiddenMe(me) && !view.spectator) {
      let av = view.meAvatar || null;
      let label = '';
      let k2 = 'p';
      if (me.dg > 0) {
        const b = bld();
        const dis = b.disguise && R.cat && R.cat.npcTypes && R.cat.npcTypes[b.disguise.npc];
        if (dis && dis.look) { av = dis.look; }
      }
      const fxT = me.fxT;
      ents.push({
        id: view.meId || me.id || '__me', k: k2, x: mp.x, y: mp.y, d: view.meFacing !== undefined ? view.meFacing : 0,
        mv: view.meMoving ? 1 : 0, st: me.st || (me.build ? 'build' : me.use ? 'use' : ''), p: me.build ? me.build.p : me.use ? me.use.p : undefined,
        fx: me.fx, fxT, need: me.need, slow: me.slow, needFrac: me.need ? clamp((me.needT || 0) / (me.needMax || 25), 0, 1) : 0,
        emo: view.meEmo || null, tm: me.team, name: view.meName || 'Du', avatar: av, label, isMe: true, dg: me.dg > 0
      });
    }
    ents.sort((a, b) => (a.x + a.y) - (b.x + b.y));

    // ---- Statische Objekte cullen ----
    const vis = R.visBuf; vis.length = 0;
    const mx = R.meX, my = R.meY, md = mx + my, ml = mx - my;
    for (const o of R.statics) {
      if (o.ax0 < vx0 - 70 || o.ax0 > vx1 + 70 || o.ay0 < vy0 - 20 || o.ay0 > vy1 + 110) continue;
      // Transparenz, wenn das Objekt die eigene Figur verdeckt
      let alpha = 1;
      if (R.haveMe && !(me && isHiddenMe(me))) {
        const dd = o.d - md, dl = Math.abs((o.x - o.y) - ml);
        const tall = o.k === 'wall' ? o.h > 0.3 : true;
        if (tall && dd > 0.05 && dd < 2.6 && dl < 1.45) alpha = 0.34;
      }
      o.alpha = o.alpha + (alpha - o.alpha) * Math.min(1, dt * 12);
      vis.push(o);
    }

    // ---- Zeichnen (Painter-Algorithmus) ----
    let i = 0, j = 0;
    const fog = view.fog !== false && !view.spectator;
    while (i < vis.length || j < ents.length) {
      if (j >= ents.length || (i < vis.length && vis[i].d <= ents[j].x + ents[j].y)) {
        const o = vis[i++];
        DIM = fog && R.brightKey !== 'all' && !isBright(o.rooms);
        HL = (o.k === 'dev' && view.nearDev !== null && view.nearDev !== undefined && o.o.id === view.nearDev) ||
             (o.k === 'hide' && view.nearHide !== null && view.nearHide !== undefined && o.o.id === view.nearHide) ||
             (o.k === 'exit' && !!(me && me.near && me.near.exit));
        if (o.alpha < 0.99) g.globalAlpha = o.alpha;
        drawStatic(o, now, view);
        g.globalAlpha = 1;
        DIM = false; HL = false;
      } else {
        drawEnt(ents[j++], now, view);
      }
    }

    // ---- Effekte über allem ----
    drawSteps(g, view, now);
    drawParts();
    drawOverlayLayer(g, view);
  }

  function isHiddenMe(me) { return !(me.hidden === null || me.hidden === undefined || me.hidden === false || me.hidden === ''); }

  function floorMarks(g, view, t) {
    C = g; DIM = false;
    // Ziel-Marker (Tap-to-Walk)
    if (view.target) {
      const p = 0.5 + 0.5 * Math.sin(t * 6);
      ell(view.target.x, view.target.y, 0.01, 0.32 + p * 0.08, 'rgba(255,216,74,0.25)');
      C.beginPath(); C.ellipse(isoX(view.target.x, view.target.y), isoY(view.target.x, view.target.y, 0), (0.3 + p * 0.1) * ERX, (0.3 + p * 0.1) * ERY, 0, 0, TAU);
      C.lineWidth = 2; C.strokeStyle = '#ffd84a'; C.stroke();
    }
    // Ausgang-Lichtkegel
    if (R.exitInner && view.me && view.me.exitOpen) {
      const a = 0.35 + 0.2 * Math.sin(t * 4);
      ell(R.exitInner.x + 0.5, R.exitInner.y + 0.5, 0.01, 0.75, 'rgba(46,204,113,' + a + ')');
    }
    // Sammel-Items: leuchtender Kreis
    for (const pk of view.pickups || []) {
      const a = 0.35 + 0.2 * Math.sin(t * 5 + pk.x);
      ell(pk.x, pk.y, 0.01, 0.3, 'rgba(255,235,59,' + a + ')');
    }
    // Fallen-Radar (rot pulsierend auf dem Boden)
    for (const r of view.radar || []) {
      const p = (t * 1.6 + r[0] * 0.3) % 1;
      C.beginPath(); C.ellipse(isoX(r[0], r[1]), isoY(r[0], r[1], 0), (0.2 + p * 0.5) * ERX, (0.2 + p * 0.5) * ERY, 0, 0, TAU);
      C.lineWidth = 2; C.strokeStyle = 'rgba(239,68,68,' + (1 - p) + ')'; C.stroke();
    }
  }

  function drawSteps(g, view, t) {
    const steps = view.steps || [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const x = s[0], y = s[1], age = s[2] !== undefined ? s[2] : ((t * 0.9 + i * 0.37) % 1);
      const cx = isoX(x, y), cy = isoY(x, y, 0);
      for (let k = 0; k < 2; k++) {
        const ph = ((age + k * 0.5) % 1);
        g.beginPath(); g.ellipse(cx, cy, (0.15 + ph * 0.75) * ERX, (0.15 + ph * 0.75) * ERY, 0, 0, TAU);
        g.lineWidth = 1.8; g.strokeStyle = 'rgba(190,220,255,' + (0.6 * (1 - ph)) + ')'; g.stroke();
      }
    }
  }

  // ---------- Overlay (Bildschirmraum, feste CSS-Größen) ----------
  function pill(g, text, x, y, font, fg, bg, border) {
    g.font = font;
    const w = g.measureText(text).width + 12, h = parseFloat(font.split(' ')[1]) + 7;
    rr(g, x - w / 2, y - h / 2, w, h, h / 2);
    g.fillStyle = bg; g.fill();
    if (border) { g.lineWidth = 2; g.strokeStyle = border; g.stroke(); }
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x, y + 0.5);
    return w;
  }

  function drawOverlayLayer(g, view) {
    const dpr = R.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = R.t;
    if (R.map) {
      const zs = clamp(0.75 + R.scale * 0.35, 0.85, 1.25);
      plaques(g, view, t, zs);
      exitSign(g, view, t, zs);
      // Pickups
      for (const pk of view.pickups || []) {
        const [x, y] = cssPos(isoX(pk.x, pk.y), isoY(pk.x, pk.y, 0.55 + 0.08 * Math.sin(t * 3 + pk.x)));
        const icon = (R.cat && R.cat.items && R.cat.items[pk.item] && R.cat.items[pk.item].icon) || '🎁';
        drawEmoji(g, icon, x, y, 20 * zs, dpr);
      }
      // Fallen-Radar Warnsymbole
      for (const r of view.radar || []) {
        const [x, y] = cssPos(isoX(r[0], r[1]), isoY(r[0], r[1], 0.9));
        const p = 1 + 0.12 * Math.sin(t * 8);
        g.save(); g.translate(x, y); g.scale(p, p);
        g.beginPath(); g.moveTo(0, -11); g.lineTo(10, 7); g.lineTo(-10, 7); g.closePath();
        g.fillStyle = '#ef4444'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke();
        g.fillStyle = '#ffffff'; g.font = '800 12px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', 0, 2);
        g.restore();
      }
      // Eigene Fallen (Perk Meister-Hirn)
      for (const tr of view.myTraps || []) {
        const [x, y] = cssPos(isoX(tr[0], tr[1]), isoY(tr[0], tr[1], 1.0 + 0.05 * Math.sin(t * 2 + tr[0])));
        drawEmoji(g, '💡', x, y, 14 * zs, dpr, 0.85);
      }
      // Figuren-Overlays: Namensschilder entzerren (vorne liegende Figuren behalten ihren Platz)
      layoutOverlays(g, zs);
      for (const o of R.ovl) entOverlay(g, o, t, zs);
      // schwebende Texte
      for (let i = R.floats.length - 1; i >= 0; i--) {
        const f = R.floats[i];
        const age = t - f.t0;
        if (age > f.life || age < 0) { R.floats.splice(i, 1); continue; }
        const [x, y] = cssPos(isoX(f.x, f.y), isoY(f.x, f.y, 1.9));
        const pop = age < 0.15 ? age / 0.15 * 1.25 : 1.25 - Math.min(0.25, (age - 0.15) * 1.5);
        g.save(); g.translate(x, y - age * 34); g.scale(pop, pop);
        g.globalAlpha = age > f.life - 0.4 ? (f.life - age) / 0.4 : 1;
        g.font = '800 17px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 4.5; g.strokeStyle = 'rgba(30,22,52,0.9)'; g.strokeText(f.text, 0, 0);
        g.fillStyle = f.col; g.fillText(f.text, 0, 0);
        g.restore();
      }
      g.globalAlpha = 1;
    }
    vignette(g);
  }

  function plaques(g, view, t, zs) {
    const me = view.me;
    const needTypes = new Set();
    if (me && me.need && R.cat && R.cat.needs && R.cat.needs[me.need]) for (const ty of R.cat.needs[me.need].types || []) needTypes.add(ty);
    else if (me && me.need) needTypes.add({ kaffee: 'kaffeeautomat', wc: 'wc', snack: 'snackautomat' }[me.need]);
    const taskTypes = new Set();
    if (me && me.tasks) for (const tk of me.tasks) if (!tk.done && tk.type) taskTypes.add(tk.type);
    const fog = view.fog !== false && !view.spectator && R.brightKey !== 'all';
    const size = 15 * zs;
    for (const o of R.visBuf) {
      if (o.k !== 'dev') continue;
      const dv = o.o;
      const isNeed = needTypes.has(dv.type), isTask = taskTypes.has(dv.type);
      const bright = !fog || isBright(o.rooms);
      if (!bright && !isNeed && !isTask) continue;
      const near = view.nearDev === dv.id;
      const bounce = near ? Math.abs(Math.sin(t * 5)) * 5 : 0;
      const [x, y0] = cssPos(o.ax0, o.ay0 - (devHeight(dv.type) + 0.32) * ZH);
      const y = y0 - bounce;
      const a = bright ? 1 : 0.55;
      g.globalAlpha = a;
      const r = size * 0.78;
      g.beginPath(); g.arc(x, y + 1.5, r, 0, TAU); g.fillStyle = 'rgba(20,10,40,0.25)'; g.fill();
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = '#ffffff'; g.fill();
      let ring = 'rgba(42,31,61,0.35)', lw = 1.2;
      if (isTask) { ring = '#3b82f6'; lw = 2.4; }
      if (isNeed) { ring = 'rgba(249,115,22,' + (0.6 + 0.4 * Math.sin(t * 6)) + ')'; lw = 3; }
      if (near) { ring = '#ffd84a'; lw = 3; }
      g.lineWidth = lw; g.strokeStyle = ring; g.stroke();
      drawEmoji(g, devIcon(dv.type), x, y, size * 0.95, R.dpr);
      if (isTask && !isNeed) { g.beginPath(); g.arc(x + r * 0.8, y - r * 0.8, 5, 0, TAU); g.fillStyle = '#3b82f6'; g.fill(); g.fillStyle = '#fff'; g.font = '800 8px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('✓', x + r * 0.8, y - r * 0.8 + 0.5); }
      if (near) {
        g.beginPath(); g.moveTo(x - 6, y - r - 9); g.lineTo(x + 6, y - r - 9); g.lineTo(x, y - r - 3); g.closePath();
        g.fillStyle = '#ffd84a'; g.fill(); g.lineWidth = 1.2; g.strokeStyle = '#2a1f3d'; g.stroke();
      }
      g.globalAlpha = 1;
    }
    // Versteck-Hinweis
    if (view.nearHide !== null && view.nearHide !== undefined) {
      const h = R.hideById.get(view.nearHide);
      if (h) {
        const [x, y] = cssPos(isoX(h.x + 0.5, h.y + 0.5), isoY(h.x + 0.5, h.y + 0.5, (HIDE_H[h.type] || 1) + 0.35) - Math.abs(Math.sin(t * 5)) * 4);
        pill(g, '🙈 Verstecken', x, y, '700 11px ' + FONT, '#2a1f3d', '#ffd84a');
      }
    }
    if (me && me.hidden !== null && me.hidden !== undefined && me.hidden !== false) {
      const h = R.hideById.get(me.hidden);
      if (h) {
        const [x, y] = cssPos(isoX(h.x + 0.5, h.y + 0.5), isoY(h.x + 0.5, h.y + 0.5, (HIDE_H[h.type] || 1) + 0.4));
        pill(g, '🫣 Versteckt', x, y, '700 11px ' + FONT, '#ffffff', 'rgba(42,31,61,0.85)', '#ffd84a');
      }
    }
  }

  function exitSign(g, view, t, zs) {
    const m = R.map;
    if (!m || !m.exit) return;
    const o = R.statics.find(s => s.k === 'exit');
    if (!o) return;
    const open = !!(view.me && view.me.exitOpen);
    const fog = view.fog !== false && !view.spectator && R.brightKey !== 'all';
    if (fog && !isBright(o.rooms) && !open) return;
    const [x, y] = cssPos(o.ax0, o.ay0 - 1.62 * ZH);
    const s = open ? 1 + 0.08 * Math.sin(t * 5) : 1;
    g.save(); g.translate(x, y); g.scale(s * zs, s * zs);
    pill(g, open ? '🏃 AUSGANG' : '🔒 AUSGANG', 0, 0, '800 12px ' + FONT, '#ffffff', open ? '#16a34a' : '#b91c1c', '#ffffff');
    g.restore();
  }

  function ovlFont(o, zs) {
    return o.name ? '700 ' + Math.round(11 * zs) + 'px ' + FONT : '600 ' + Math.round(9.5 * zs) + 'px ' + FONT;
  }
  function layoutOverlays(g, zs) {
    const list = R.ovl;
    for (const o of list) {
      const [x, y] = cssPos(o.x, o.y);
      o.cx = x; o.cy = o.name ? y : y + 3;
      const txt = o.name ? (o.dg ? '🥸 ' + o.name : o.name) : o.label;
      o.txt = txt;
      if (txt) {
        const f = ovlFont(o, zs);
        g.font = f;
        o.pw = g.measureText(txt).width + 12;
        o.ph = parseFloat(f.split(' ')[1]) + 7;
      } else { o.pw = 0; o.ph = 0; }
    }
    list.sort((a, b) => b.feetY - a.feetY);
    const placed = [];
    for (const o of list) {
      if (!o.pw) continue;
      let ty = o.cy;
      for (let it = 0; it < 8; it++) {
        let moved = false;
        for (const r of placed) {
          if (Math.abs(o.cx - r.cx) < (o.pw + r.pw) / 2 + 2 && Math.abs(ty - r.ly) < (o.ph + r.ph) / 2 + 1) {
            ty = r.ly - (o.ph + r.ph) / 2 - 2; moved = true;
          }
        }
        if (!moved) break;
      }
      o.ly = ty;
      placed.push(o);
    }
  }

  function entOverlay(g, o, t, zs) {
    const x = o.cx;
    let yy = (o.ly !== undefined && o.pw) ? o.ly : o.cy;
    if (x < -60 || yy < -80 || x > R.cw + 60 || yy > R.ch + 80) return;
    g.save();
    // Verbindungsstrich, falls das Schild verschoben wurde
    if (o.pw && Math.abs(yy - o.cy) > 3) {
      g.beginPath(); g.moveTo(x, yy + o.ph / 2); g.lineTo(x, o.cy - o.ph / 2 + 4);
      g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,255,255,0.7)'; g.stroke();
    }
    // Namensschild
    if (o.name) {
      const bg = o.team ? o.team : 'rgba(30,22,52,0.82)';
      pill(g, o.txt, x, yy, ovlFont(o, zs), '#ffffff', bg, o.isMe ? '#ffd84a' : 'rgba(255,255,255,0.85)');
    } else if (o.label) {
      pill(g, o.txt, x, yy, ovlFont(o, zs), '#3b2f55', 'rgba(255,255,255,0.8)');
    }
    // Fortschrittsring
    if ((o.st === 'build' || o.st === 'use' || o.st === 'search') && o.p !== undefined && o.p !== null) {
      const r = 11 * zs;
      const cy = yy - (o.ph || 14) / 2 - r - 3;
      g.beginPath(); g.arc(x, cy, r, 0, TAU); g.fillStyle = 'rgba(30,22,52,0.8)'; g.fill();
      g.beginPath(); g.arc(x, cy, r - 1.5, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(o.p, 0, 1));
      g.lineWidth = 3.4; g.strokeStyle = o.st === 'build' ? '#ff9f1c' : o.st === 'search' ? '#38bdf8' : '#22c55e'; g.stroke();
      drawEmoji(g, o.st === 'build' ? '🔧' : o.st === 'search' ? '🔍' : '✋', x, cy, 11 * zs, R.dpr);
    }
    // Bedürfnis-Blase
    if (o.need) {
      const icon = (R.cat && R.cat.needs && R.cat.needs[o.need] && R.cat.needs[o.need].icon) || ({ kaffee: '☕', wc: '🚻', snack: '🍫' }[o.need]) || '❗';
      const shake = o.slow ? Math.sin(t * 30) * 1.5 : 0;
      const r = 12 * zs;
      const bx = x + Math.max(10 * zs, (o.pw || 0) / 2) + r + 3 + shake, by = yy - 9 * zs;
      g.beginPath(); g.arc(bx, by, r, 0, TAU);
      g.moveTo(bx - r * 0.6, by + r * 0.6); g.lineTo(bx - r * 1.3, by + r * 1.35); g.lineTo(bx - r * 0.1, by + r * 0.95);
      g.fillStyle = '#ffffff'; g.fill();
      g.lineWidth = 2; g.strokeStyle = o.slow ? '#ef4444' : '#2a1f3d'; g.stroke();
      if (o.isMe && o.needFrac) {
        g.beginPath(); g.arc(bx, by, r + 2.5, -Math.PI / 2, -Math.PI / 2 + TAU * o.needFrac);
        g.lineWidth = 2.6; g.strokeStyle = o.needFrac > 0.75 ? '#ef4444' : '#f59e0b'; g.stroke();
      }
      drawEmoji(g, icon, bx, by, 15 * zs, R.dpr);
    }
    // Emoji-Blase
    if (o.emo && o.emoAge >= 0) {
      const a = o.emoAge;
      const sc = a < 0.18 ? (a / 0.18) * 1.25 : (a < 0.3 ? 1.25 - (a - 0.18) / 0.12 * 0.25 : 1);
      const ey = yy - (o.ph || 14) / 2 - 20 * zs - ((o.st === 'build' || o.st === 'use' || o.st === 'search') ? 24 * zs : 0) - Math.sin(t * 3) * 2;
      g.save(); g.translate(x, ey); g.scale(sc, sc);
      g.beginPath(); g.arc(0, 0, 17 * zs, 0, TAU); g.fillStyle = 'rgba(255,255,255,0.95)'; g.fill();
      g.lineWidth = 2; g.strokeStyle = '#2a1f3d'; g.stroke();
      drawEmoji(g, o.emo, 0, 0, 22 * zs, R.dpr * sc);
      g.restore();
    }
    g.restore();
  }

  function vignette(g) {
    const key = R.canvas.width + 'x' + R.canvas.height;
    if (!R.vign || R.vignKey !== key) {
      const c = document.createElement('canvas');
      c.width = Math.max(2, Math.round(R.cw)); c.height = Math.max(2, Math.round(R.ch));
      const vg = c.getContext('2d');
      const cx = c.width / 2, cy = c.height / 2, r = Math.hypot(cx, cy);
      const gr = vg.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
      gr.addColorStop(0, 'rgba(10,5,30,0)');
      gr.addColorStop(1, 'rgba(10,5,30,0.42)');
      vg.fillStyle = gr; vg.fillRect(0, 0, c.width, c.height);
      R.vign = c; R.vignKey = key;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(R.vign, 0, 0, R.canvas.width, R.canvas.height);
  }

  // ---------- Koordinaten-Umrechnung ----------
  function ensureTransform() {
    if (R.lastT !== null && R.k > 0 && R.map) return;
    R.scale = effScale(R.zoom || 1);
    R.k = R.scale * R.dpr;
    const c = R.mapCenter || { x: 0, y: 0 };
    R.tx = R.canvas ? R.canvas.width / 2 - isoX(c.x, c.y) * R.k : 0;
    R.ty = R.canvas ? R.canvas.height / 2 - isoY(c.x, c.y, 0) * R.k : 0;
  }
  function screenToWorld(sx, sy) {
    ensureTransform();
    const ix = (sx * R.dpr - R.tx) / R.k, iy = (sy * R.dpr - R.ty) / R.k;
    return { x: (ix / HW + iy / HH) / 2, y: (iy / HH - ix / HW) / 2 };
  }
  function worldToScreen(x, y) {
    ensureTransform();
    const [cx, cy] = cssPos(isoX(x, y), isoY(x, y, 0));
    return { x: cx, y: cy };
  }
  function screenDirToWorld(dx, dy) {
    const x = (dx / HW + dy / HH) / 2, y = (dy / HH - dx / HW) / 2;
    const l = Math.hypot(x, y);
    if (l < 1e-6) return { x: 0, y: 0 };
    return { x: x / l, y: y / l };
  }

  function hitDevice(sx, sy) {
    if (!R.map) return null;
    ensureTransform();
    let best = null, bd = Infinity;
    const thr = Math.max(26, 34 * R.scale);
    for (const d of R.map.devices) {
      let x = d.x + 0.5, y = d.y + 0.5, h = devHeight(d.type);
      const rp = R.robotPos.get(d.id);
      if (rp) { if (!rp.seen) continue; x = rp.x; y = rp.y; h = 0.3; }
      for (const z of [h * 0.5, h * 0.9, 0.1]) {
        const [cx, cy] = cssPos(isoX(x, y), isoY(x, y, z));
        const dd = Math.hypot(cx - sx, cy - sy);
        if (dd < thr && dd < bd) { bd = dd; best = d.id; }
      }
    }
    return best;
  }
  function hitHide(sx, sy) {
    if (!R.map) return null;
    ensureTransform();
    let best = null, bd = Infinity;
    const thr = Math.max(26, 34 * R.scale);
    for (const h of R.map.hides) {
      const hh = HIDE_H[h.type] || 1;
      for (const z of [hh * 0.5, hh * 0.9, 0.1]) {
        const [cx, cy] = cssPos(isoX(h.x + 0.5, h.y + 0.5), isoY(h.x + 0.5, h.y + 0.5, z));
        const dd = Math.hypot(cx - sx, cy - sy);
        if (dd < thr && dd < bd) { bd = dd; best = h.id; }
      }
    }
    return best;
  }

  // ---------- Avatar für Editor / Lobby / Ergebnis ----------
  /**
   * (cx, cy) = optische Mitte der Figur; Gesamthöhe ≈ 64 * scale CSS-Pixel (inkl. Haare).
   * Zeichnet einen weichen Bodenschatten mit.
   */
  function drawAvatar(ctx, avatar, cx, cy, scale, opts) {
    if (!ctx) return;
    opts = opts || {};
    scale = scale || 1;
    const prevC = C, prevDim = DIM, prevHL = HL;
    DIM = false; HL = false; C = ctx;
    const t = opts.t !== undefined ? opts.t : performance.now() / 1000;
    ctx.save();
    ctx.translate(cx, cy + 30 * scale);
    ctx.scale(scale, scale);
    ctx.beginPath(); ctx.ellipse(0, 0, 15, 5.5, 0, 0, TAU); ctx.fillStyle = 'rgba(20,10,40,0.22)'; ctx.fill();
    const pose = opts.pose || 'idle';
    drawFigure(ctx, avatar || {}, {
      f: opts.facing === -1 ? -1 : 1, back: !!opts.back,
      walk: pose === 'walk' ? t * 10 : null, pose: pose === 'walk' ? 'idle' : pose, t, seed: opts.seed || 0.3,
      face: opts.face
    });
    ctx.restore();
    C = prevC; DIM = prevDim; HL = prevHL;
  }

  // ---------- Minimap ----------
  function drawMinimap(ctx, w, h, opts) {
    if (!ctx || !R.map) return;
    opts = opts || {};
    const m = R.map;
    const tr = ctx.getTransform ? ctx.getTransform() : { a: 1, b: 0 };
    const pr = Math.max(1, Math.hypot(tr.a, tr.b));
    const isoW = (m.w + m.h) * HW, isoH = (m.w + m.h) * HH;
    const pad = 6;
    const s = Math.min((w - pad * 2) / isoW, (h - pad * 2) / isoH);
    const ox = w / 2 - ((m.w - m.h) / 2) * HW * s, oy = h / 2 - ((m.w + m.h) / 2) * HH * s;
    const key = w + 'x' + h + '@' + pr + '#' + (R.world ? 1 : 0) + m.w + 'x' + m.h + (m.rooms.length);
    if (!R.miniCache || R.miniKey !== key) {
      const c = document.createElement('canvas');
      c.width = Math.ceil(w * pr); c.height = Math.ceil(h * pr);
      const g2 = c.getContext('2d');
      g2.setTransform(pr * s * HW, pr * s * HH, -pr * s * HW, pr * s * HH, ox * pr, oy * pr);
      for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
        const tt = m.tiles[j * m.w + i];
        if (tt === T_WALL || tt === T_EXIT) { g2.fillStyle = '#2a2448'; g2.fillRect(i, j, 1.02, 1.02); }
        else if (tt === T_DOOR) { g2.fillStyle = '#d6cfe8'; g2.fillRect(i, j, 1.02, 1.02); }
      }
      for (const r of m.rooms) {
        const st = roomStyle(r);
        g2.fillStyle = st.floor; g2.fillRect(r.x, r.y, r.w, r.h);
      }
      for (const wt of R.waterList) { g2.fillStyle = '#2aa2ee'; g2.fillRect(wt.x, wt.y, 1, 1); }
      for (const d of m.devices) { if (R.robotPos.has(d.id)) continue; g2.fillStyle = 'rgba(42,31,61,0.45)'; g2.fillRect(d.x + 0.15, d.y + 0.15, 0.7, 0.7); }
      R.miniCache = c; R.miniKey = key;
    }
    ctx.save();
    ctx.drawImage(R.miniCache, 0, 0, w, h);
    const P2 = (x, y) => [ox + (x - y) * HW * s, oy + (x + y) * HH * s];
    // Nebel
    if (opts.fog !== false && R.brightKey !== 'all' && R.bright.size) {
      ctx.save();
      ctx.transform(HW * s, HH * s, -HW * s, HH * s, ox, oy);
      ctx.fillStyle = 'rgba(14,18,44,0.45)';
      for (const r of m.rooms) if (!R.bright.has(r.id)) ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }
    const t = R.t;
    // Ausgang
    const ex = opts.exit || (m.exit ? { x: m.exit.x + 0.5, y: m.exit.y + 0.5, open: false } : null);
    if (ex) {
      const [x, y] = P2(ex.x, ex.y);
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, TAU); ctx.fillStyle = ex.open ? '#22c55e' : '#ef4444'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    }
    // Ziele
    for (const tg of opts.targets || []) {
      const [x, y] = P2(tg.x, tg.y);
      const p = 1 + 0.15 * Math.sin(t * 5 + tg.x);
      ctx.beginPath(); ctx.arc(x, y, 6.5 * p, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill();
      ctx.lineWidth = 1.4; ctx.strokeStyle = '#f59e0b'; ctx.stroke();
      if (tg.icon) drawEmoji(ctx, tg.icon, x, y, 8.5, pr);
    }
    // Ich
    if (opts.me) {
      const [x, y] = P2(opts.me.x, opts.me.y);
      const p = (t * 1.2) % 1;
      ctx.beginPath(); ctx.arc(x, y, 4 + p * 7, 0, TAU); ctx.strokeStyle = 'rgba(255,216,74,' + (1 - p) + ')'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fillStyle = '#ffd84a'; ctx.fill();
      ctx.lineWidth = 1.6; ctx.strokeStyle = '#2a1f3d'; ctx.stroke();
    }
    ctx.restore();
  }

  function shake(intensity) {
    R.shakeAmp = Math.max(R.shakeAmp, clamp(intensity === undefined ? 1 : intensity, 0, 4) * 6);
  }

  function setCatalog(cat) {
    R.cat = cat || null;
    _sh.clear();
    if (R.map) { for (const r of R.map.rooms) r._st = null; R.floor = null; R.miniCache = null; }
  }

  window.Render = {
    init, resize, setCatalog, setWorld, clearWorld, frame,
    screenToWorld, worldToScreen, screenDirToWorld,
    burst, floatText, shake, drawAvatar, drawMinimap, hitDevice, hitHide
  };
})();

/* =====================================================================
   STREICHE ALARM – Client-App
   Netzwerk (Socket.io), Menüs, Lobby, HUD, Steuerung, Fallen-Rad,
   Sound (Web Audio) und deutsche Sprachausgabe.
   Das Zeichnen der Spielwelt übernimmt window.Render (render.js).
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     0. Grundlagen & Hilfsfunktionen
     ------------------------------------------------------------------ */
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => performance.now();

  function h(tag, props) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (typeof v !== 'string' && k in e) e[k] = v;
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) appendKid(e, arguments[i]);
    return e;
  }
  function appendKid(e, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => appendKid(e, x)); return; }
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  function show(sel, on) { const e = typeof sel === 'string' ? $(sel) : sel; if (e) e.classList.toggle('hidden', !on); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtSec(s) { return (Math.round(s * 10) / 10).toString().replace('.', ',') + ' s'; }
  function load(key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  }
  function store(key, val) {
    try { if (val === null || val === undefined) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* Speicher voll oder gesperrt */ }
  }
  function genitive(name) { return /[sßxz]$/i.test(name) ? name + '’' : name + 's'; }
  function vibrate(p) { if (S.settings.vibrate && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { /* egal */ } } }

  const isTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const sideLayoutMQ = window.matchMedia ? matchMedia('(min-width: 820px), (orientation: landscape) and (max-height: 560px)') : { matches: true };

  /* Fallback, falls render.js fehlt – Menüs funktionieren dann trotzdem */
  const Render = window.Render || {
    init() {}, resize() {}, setCatalog() {}, setWorld() {}, clearWorld() {}, frame() {},
    screenToWorld() { return { x: 0, y: 0 }; }, worldToScreen() { return { x: 0, y: 0 }; },
    screenDirToWorld(dx, dy) { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; },
    burst() {}, floatText() {}, shake() {}, drawAvatar() {}, drawMinimap() {}, hitDevice() { return null; }, hitHide() { return null; }
  };
  function safe(fn) { try { return fn(); } catch (e) { if (!safe.logged) { safe.logged = true; console.warn('Render-Fehler:', e); } return undefined; } }

  /* ------------------------------------------------------------------
     1. Zustand
     ------------------------------------------------------------------ */
  const defaultSettings = { controls: 'joystick', sound: true, voice: true, zoom: 1, minimap: true, vibrate: true };
  const S = {
    catalog: null,
    account: load('sl_account', null),
    profile: load('sl_profile', null),
    settings: Object.assign({}, defaultSettings, load('sl_settings', {})),
    loggedIn: false,
    connectedOnce: false,
    view: 'loading',
    rooms: [],
    room: null,
    roomCode: null,
    pendingRoom: null,
    myId: null,
    world: null,
    practice: false,
    spectator: false,
    followId: null,
    players: {},
    devById: {},
    hideById: {},
    solid: null,
    snaps: [],
    lastSnap: null,
    me: null,
    pred: null,
    facing: 0,
    moving: false,
    cam: null,
    offset: null,
    tl: null,
    tlAt: 0,
    keys: {},
    joy: { active: false, id: null, bx: 0, by: 0, vx: 0, vy: 0 },
    input: { x: 0, y: 0 },
    lastSent: { x: 0, y: 0, t: 0 },
    target: null,
    wheel: null,
    wheelOpen: false,
    lobbyCollapsed: false,
    resultsOpen: false,
    stepsSeen: {},
    steps: [],
    sheet: null,
    installPrompt: null,
    hudKeys: {}
  };
  const INTERP_DELAY = 100;
  const R_PLAYER = 0.3;

  /* ------------------------------------------------------------------
     2. Code- und Namensprüfung (identisch zur Server-Regel)
     ------------------------------------------------------------------ */
  function codeProblem(code) {
    if (!/^\d{4}$/.test(code)) return 'Der Code muss genau 4 Ziffern haben.';
    const d = code.split('').map(Number);
    if (d.every((x) => x === d[0])) return 'Bitte keine Wiederholungen wie 0000 oder 1111.';
    const asc = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
    const desc = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
    if (asc || desc || code === '7890' || code === '0987') return 'Bitte keine einfachen Zahlenfolgen wie 1234 oder 9876.';
    if (d[0] === d[2] && d[1] === d[3]) return 'Muster wie 1212 sind zu leicht zu erraten.';
    if (d[0] === d[1] && d[2] === d[3]) return 'Muster wie 1122 sind zu leicht zu erraten.';
    return null;
  }
  function suggestCode() {
    for (let i = 0; i < 200; i++) {
      const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
      if (!codeProblem(c)) return c;
    }
    return '7842';
  }
  function nameProblem(name) {
    const n = (name || '').trim();
    if (n.length < 2) return 'Der Name braucht mindestens 2 Zeichen.';
    if (n.length > 16) return 'Der Name darf höchstens 16 Zeichen haben.';
    if (!/^[\p{L}\p{N} ._\-]+$/u.test(n)) return 'Erlaubt sind Buchstaben, Ziffern, Leerzeichen, Punkt, - und _.';
    return null;
  }

  /* ------------------------------------------------------------------
     3. Sound (Web Audio, alles synthetisch)
     ------------------------------------------------------------------ */
  const Sfx = (function () {
    let ac = null, out = null, noiseBuf = null, on = true;
    function init() {
      if (ac) { if (ac.state === 'suspended') ac.resume().catch(() => {}); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { ac = new AC(); } catch (e) { ac = null; return; }
      out = ac.createGain();
      out.gain.value = 0.55;
      const comp = ac.createDynamicsCompressor();
      out.connect(comp); comp.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    function env(g, t0, a, dur, v) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t0 + Math.max(0.002, a));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    }
    function osc(o) {
      const t0 = ac.currentTime + (o.at || 0);
      const os = ac.createOscillator();
      os.type = o.type || 'sine';
      os.frequency.setValueAtTime(o.f, t0);
      if (o.f2) os.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t0 + (o.slide || o.dur));
      const g = ac.createGain();
      env(g, t0, o.a || 0.008, o.dur, o.v || 0.3);
      let node = os;
      if (o.lfo) {
        const l = ac.createOscillator();
        l.frequency.value = o.lfo;
        const lg = ac.createGain();
        lg.gain.value = o.lfoDepth || 20;
        l.connect(lg); lg.connect(os.frequency);
        l.start(t0); l.stop(t0 + o.dur + 0.05);
      }
      if (o.lp) {
        const f = ac.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = o.lp;
        node.connect(f); node = f;
      }
      node.connect(g); g.connect(out);
      os.start(t0); os.stop(t0 + o.dur + 0.05);
    }
    function noise(o) {
      const t0 = ac.currentTime + (o.at || 0);
      const src = ac.createBufferSource();
      src.buffer = noiseBuf; src.loop = true;
      const f = ac.createBiquadFilter();
      f.type = o.type || 'bandpass';
      f.frequency.setValueAtTime(o.f || 1000, t0);
      if (o.f2) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + o.dur);
      f.Q.value = o.q || 1;
      const g = ac.createGain();
      env(g, t0, o.a || 0.01, o.dur, o.v || 0.3);
      src.connect(f); f.connect(g); g.connect(out);
      src.start(t0); src.stop(t0 + o.dur + 0.05);
    }
    const lib = {
      klick() { osc({ type: 'square', f: 1400, f2: 700, dur: 0.05, v: 0.1, lp: 4000 }); },
      tick() { osc({ type: 'sine', f: 880, dur: 0.14, v: 0.28 }); },
      go() { osc({ type: 'triangle', f: 523, dur: 0.16, v: 0.3 }); osc({ type: 'triangle', f: 784, dur: 0.16, v: 0.3, at: 0.1 }); osc({ type: 'triangle', f: 1047, dur: 0.45, v: 0.3, at: 0.2 }); },
      boing() { osc({ type: 'triangle', f: 140, f2: 640, dur: 0.32, v: 0.38, lfo: 16, lfoDepth: 45 }); },
      bonk() { osc({ type: 'sine', f: 420, f2: 90, dur: 0.2, v: 0.45 }); noise({ dur: 0.06, v: 0.25, f: 2400, q: 0.8 }); },
      slurp() { osc({ type: 'sine', f: 260, f2: 900, dur: 0.5, v: 0.22, lfo: 22, lfoDepth: 70 }); noise({ dur: 0.45, v: 0.07, type: 'highpass', f: 3200 }); },
      zisch() { noise({ dur: 0.75, v: 0.3, type: 'highpass', f: 3800, f2: 7500, a: 0.02 }); osc({ type: 'sine', f: 1800, f2: 2600, dur: 0.4, v: 0.05 }); },
      splash() { noise({ dur: 0.6, v: 0.42, type: 'lowpass', f: 3200, f2: 260 }); osc({ type: 'sine', f: 640, f2: 180, dur: 0.22, v: 0.16 }); },
      plopp() { osc({ type: 'sine', f: 950, f2: 170, dur: 0.11, v: 0.35 }); },
      blubb() { for (let i = 0; i < 6; i++) osc({ type: 'sine', f: 260 + Math.random() * 300, f2: 700 + Math.random() * 500, dur: 0.08, v: 0.22, at: i * 0.075 }); },
      quietsch() { osc({ type: 'square', f: 1300, f2: 2200, dur: 0.28, v: 0.08, lfo: 30, lfoDepth: 220, lp: 3200 }); },
      lachen() { for (let i = 0; i < 5; i++) osc({ type: 'sawtooth', f: 430 - i * 26, f2: 300 - i * 24, dur: 0.11, v: 0.13, at: i * 0.13, lp: 1800, lfo: 9, lfoDepth: 14 }); },
      alarm() { for (let i = 0; i < 4; i++) osc({ type: 'square', f: i % 2 ? 660 : 880, dur: 0.14, v: 0.11, at: i * 0.15, lp: 2600 }); },
      fanfare() { [523, 659, 784, 1047].forEach((f, i) => osc({ type: 'triangle', f, dur: i === 3 ? 0.55 : 0.17, v: 0.26, at: i * 0.12 })); },
      win() {
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => osc({ type: 'triangle', f, dur: i === 5 ? 0.8 : 0.16, v: 0.26, at: i * 0.13 }));
        [262, 330, 392].forEach((f) => osc({ type: 'sine', f, dur: 1.1, v: 0.1, at: 0.65 }));
      },
      ding() { osc({ type: 'sine', f: 1318, dur: 0.5, v: 0.22 }); osc({ type: 'sine', f: 1976, dur: 0.35, v: 0.08 }); },
      join() { osc({ type: 'sine', f: 784, dur: 0.35, v: 0.26 }); osc({ type: 'sine', f: 1175, dur: 0.6, v: 0.26, at: 0.14 }); osc({ type: 'sine', f: 1568, dur: 0.7, v: 0.13, at: 0.28 }); },
      whoosh() { noise({ dur: 0.45, v: 0.32, type: 'bandpass', f: 280, f2: 2600, q: 2.5 }); },
      furz() { osc({ type: 'sawtooth', f: 96, f2: 58, dur: 0.6, v: 0.32, lfo: 27, lfoDepth: 26, lp: 620 }); noise({ dur: 0.5, v: 0.1, type: 'lowpass', f: 420 }); },
      slide() { osc({ type: 'sine', f: 480, f2: 1500, dur: 0.22, v: 0.24 }); osc({ type: 'sine', f: 1500, f2: 300, dur: 0.35, v: 0.24, at: 0.22 }); },
      brrr() { osc({ type: 'sawtooth', f: 130, dur: 0.65, v: 0.16, lfo: 34, lfoDepth: 60, lp: 900 }); },
      puff() { noise({ dur: 0.55, v: 0.32, type: 'lowpass', f: 1000, f2: 180 }); },
      konfetti() { for (let i = 0; i < 9; i++) osc({ type: 'sine', f: 700 + Math.random() * 1400, dur: 0.06, v: 0.12, at: i * 0.04 }); lib.fanfare(); },
      pickup() { osc({ type: 'square', f: 988, dur: 0.08, v: 0.11, lp: 3000 }); osc({ type: 'square', f: 1319, dur: 0.22, v: 0.11, at: 0.08, lp: 3000 }); },
      coins() { osc({ type: 'triangle', f: 1568, dur: 0.08, v: 0.14 }); osc({ type: 'triangle', f: 2093, dur: 0.22, v: 0.14, at: 0.06 }); },
      error() { osc({ type: 'square', f: 220, f2: 140, dur: 0.25, v: 0.1, lp: 1200 }); },
      need() { osc({ type: 'sine', f: 660, dur: 0.1, v: 0.25 }); osc({ type: 'sine', f: 990, dur: 0.2, v: 0.25, at: 0.1 }); },
      build() { for (let i = 0; i < 4; i++) osc({ type: 'square', f: 300 + i * 90, dur: 0.04, v: 0.08, at: i * 0.06, lp: 2000 }); },
      armed() { osc({ type: 'sine', f: 520, dur: 0.08, v: 0.2 }); osc({ type: 'sine', f: 390, dur: 0.18, v: 0.2, at: 0.09 }); }
    };
    return {
      init,
      play(name) { if (!on || !ac || !lib[name]) return; try { lib[name](); } catch (e) { /* Ton egal */ } },
      set(v) { on = !!v; }
    };
  })();
  const FX_SOUND = {
    hot: 'zisch', yuck: 'quietsch', splash: 'splash', foam: 'blubb', shake: 'brrr', launch: 'boing', bonk: 'bonk', wet: 'splash',
    sticky: 'quietsch', tangle: 'whoosh', spin: 'slide', slip: 'slide', confetti: 'konfetti', mummy: 'whoosh', paint: 'splash',
    soot: 'puff', squash: 'boing', toot: 'furz'
  };

  /* ------------------------------------------------------------------
     4. Deutsche Sprachausgabe (speechSynthesis, Warteschlange)
     ------------------------------------------------------------------ */
  const Voice = (function () {
    const synth = window.speechSynthesis;
    let on = true, unlocked = false, voice = null, q = [], busy = false, guard = 0;
    const last = {};
    function pick() {
      if (!synth) return;
      const vs = synth.getVoices() || [];
      const de = vs.filter((v) => /^de/i.test(v.lang));
      const pref = ['Google Deutsch', 'Anna', 'Petra', 'Helena', 'Katja', 'Markus', 'Hedda', 'Stefan', 'Conrad', 'Amala', 'Viktor', 'Yannick'];
      voice = de.find((v) => /de[-_]DE/i.test(v.lang) && pref.some((p) => v.name.indexOf(p) >= 0)) ||
        de.find((v) => /de[-_]DE/i.test(v.lang)) || de.find((v) => /de[-_]AT/i.test(v.lang)) || de[0] || null;
    }
    if (synth) {
      pick();
      if (synth.addEventListener) synth.addEventListener('voiceschanged', pick);
      else synth.onvoiceschanged = pick;
    }
    function unlock() {
      if (unlocked || !synth) return;
      unlocked = true;
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; u.lang = 'de-DE'; synth.speak(u); } catch (e) { /* egal */ }
    }
    function pump() {
      if (busy || !q.length) return;
      const it = q.shift();
      if (Date.now() - it.t > 4500) { pump(); return; }
      let u;
      try { u = new SpeechSynthesisUtterance(it.text); } catch (e) { return; }
      u.lang = 'de-DE';
      if (voice) u.voice = voice;
      u.pitch = it.pitch; u.rate = it.rate; u.volume = 1;
      busy = true;
      const done = () => { if (!busy) return; busy = false; clearTimeout(guard); setTimeout(pump, 90); };
      u.onend = done; u.onerror = done;
      guard = setTimeout(() => { try { synth.cancel(); } catch (e) { /* egal */ } done(); }, 2600 + it.text.length * 95);
      try { synth.speak(u); } catch (e) { done(); }
    }
    function say(text, o) {
      o = o || {};
      if (!on || !unlocked || !synth || !text) return;
      const t = Date.now();
      if (last[text] && t - last[text] < 2800) return;
      last[text] = t;
      const item = { text, t, pitch: o.pitch || 1.1, rate: o.rate || 1.05, prio: o.prio || 0 };
      if (item.prio >= 2) q = q.filter((x) => x.prio >= 2);
      q.push(item);
      q.sort((a, b) => b.prio - a.prio);
      if (q.length > 3) q.length = 3;
      pump();
    }
    return {
      unlock, say,
      set(v) { on = !!v; if (!on && synth) { q = []; try { synth.cancel(); } catch (e) { /* egal */ } } },
      available: !!synth
    };
  })();

  function unlockAudio() {
    Sfx.init();
    Voice.unlock();
  }
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio);

  /* ------------------------------------------------------------------
     5. Toasts, Modals, große Meldungen
     ------------------------------------------------------------------ */
  function toast(msg, kind, ms) {
    const box = $('#toasts');
    const t = h('div', { class: 'toast ' + (kind || 'info') }, msg);
    box.appendChild(t);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 420); }, ms || 2600);
  }
  let bigMsgTimer = 0;
  function bigMsg(text, kind) {
    const e = $('#bigMsg');
    e.textContent = text;
    e.className = 'big-msg ' + (kind || '');
    void e.offsetWidth;
    e.classList.add('anim');
    clearTimeout(bigMsgTimer);
    bigMsgTimer = setTimeout(() => e.classList.add('hidden'), 1850);
  }
  function confirmBox(text, yesLabel, noLabel) {
    return new Promise((resolve) => {
      $('#modalText').textContent = text;
      $('#modalYes').textContent = yesLabel || 'OK';
      $('#modalNo').textContent = noLabel || 'Abbrechen';
      show('#modal', true);
      const finish = (v) => { show('#modal', false); $('#modalYes').onclick = null; $('#modalNo').onclick = null; resolve(v); };
      $('#modalYes').onclick = () => finish(true);
      $('#modalNo').onclick = () => finish(false);
    });
  }
  function infoBox(text) {
    return new Promise((resolve) => {
      $('#modalText').textContent = text;
      $('#modalYes').textContent = 'Alles klar';
      show('#modalNo', false);
      show('#modal', true);
      $('#modalYes').onclick = () => { show('#modal', false); show('#modalNo', true); $('#modalYes').onclick = null; resolve(true); };
    });
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text));
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    const ta = h('textarea', { style: 'position:fixed;left:-999px;top:0;opacity:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  /* ------------------------------------------------------------------
     6. Avatar-Zeichnung für Menüs (passt jede Figur automatisch ein)
     ------------------------------------------------------------------ */
  const AV = { box: null, bust: null };
  function measureOne(sample) {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 400;
    const x = c.getContext('2d');
    Render.drawAvatar(x, sample, 200, 200, 1, { facing: 1, pose: 'idle', t: 0 });
    const d = x.getImageData(0, 0, 400, 400).data;
    let x0 = 400, y0 = 400, x1 = -1, y1 = -1;
    for (let y = 0; y < 400; y++) {
      for (let xx = 0; xx < 400; xx++) {
        if (d[(y * 400 + xx) * 4 + 3] > 12) {
          if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return (x1 > x0 && y1 > y0) ? { l: x0 - 200, r: x1 - 200, t: y0 - 200, b: y1 - 200 } : null;
  }
  /** Misst einmalig, wie groß Render.drawAvatar zeichnet – so passt jede Figur in jedes Menü-Canvas */
  function measureAvatar() {
    try {
      AV.box = measureOne({ skin: 1, hair: 'afro', hairColor: 0, face: 'grinsen', outfit: 'arztkittel', outfitColor: 0, acc: 'zylinder' });
      AV.bust = measureOne({ skin: 1, hair: 'kurz', hairColor: 0, face: 'grinsen', outfit: 'hemd', outfitColor: 0, acc: 'keins' }) || AV.box;
    } catch (e) { AV.box = null; AV.bust = null; }
  }
  function prepCanvas(cv, w, hgt) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(w * dpr), H = Math.round(hgt * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    return ctx;
  }
  /** Zeichnet einen Avatar passend in ein Canvas (opts.crop: 'bust' für Brustbild) */
  function drawAvatarFit(cv, avatar, w, hgt, opts) {
    opts = opts || {};
    const ctx = prepCanvas(cv, w, hgt);
    if (!avatar) return;
    const bust = opts.crop === 'bust';
    const box = (bust ? AV.bust : AV.box) || { l: -26, r: 26, t: -70, b: 6 };
    const bt = box.t - (bust ? 3 : 0);
    const bb = bust ? box.t + (box.b - box.t) * 0.6 : box.b;
    const bw = box.r - box.l, bh = bb - bt;
    const pad = opts.pad === undefined ? 0.06 : opts.pad;
    const sc = Math.min(w * (1 - pad * 2) / bw, hgt * (1 - pad * 2) / bh);
    const cx = w / 2 - (box.l + bw / 2) * sc;
    const cy = (hgt - bh * sc) / 2 - bt * sc;
    safe(() => Render.drawAvatar(ctx, avatar, cx, cy, sc, { facing: opts.facing || 1, pose: opts.pose || 'idle', t: opts.t || 0 }));
  }

  /* ------------------------------------------------------------------
     7. Katalog-Helfer
     ------------------------------------------------------------------ */
  const C = () => S.catalog || {};
  function shopEntry(id) { return (C().shop || {})[id] || null; }
  function owns(id) {
    if (!shopEntry(id)) return true; // nicht im Shop = gratis
    const p = S.profile;
    if (!p) return false;
    if (id === 'master') return !!p.master;
    const m = /^slot(\d)$/.exec(id);
    if (m) return (p.slots || 3) >= Number(m[1]);
    return (p.unlocked || []).indexOf(id) >= 0;
  }
  function partList(kind) { return ((C().avatar || {})[kind]) || []; }
  function freeParts(kind) { return partList(kind).filter((p) => owns(kind + ':' + p.id)); }
  function randomFreeAvatar() {
    const av = C().avatar || {};
    const pickId = (kind, fb) => { const l = freeParts(kind); return l.length ? l[Math.floor(Math.random() * l.length)].id : fb; };
    return {
      skin: Math.floor(Math.random() * Math.max(1, (av.skins || [1]).length)),
      hair: pickId('hair', 'kurz'),
      hairColor: Math.floor(Math.random() * Math.max(1, (av.hairColors || [1]).length)),
      face: pickId('face', 'grinsen'),
      outfit: pickId('outfit', 'hemd'),
      outfitColor: Math.floor(Math.random() * Math.max(1, (av.outfitColors || [1]).length)),
      acc: Math.random() < 0.5 ? 'keins' : pickId('acc', 'keins')
    };
  }
  function myAvatar() { return (S.profile && S.profile.avatar) || { skin: 1, hair: 'kurz', hairColor: 0, face: 'grinsen', outfit: 'hemd', outfitColor: 0, acc: 'keins' }; }
  function trapInfo(id) { return (C().traps || {})[id] || { name: 'Falle', icon: '🪤', line: 'Autsch!' }; }
  function teamInfo(t) { const l = C().teams || [{ name: 'Team Blau', color: '#3b82f6' }, { name: 'Team Orange', color: '#f97316' }]; return l[t] || { name: 'Team', color: '#888' }; }
  function emotesOwned() {
    const list = C().emotes || ['😂', '☕', '🤕', '👀'];
    return list.filter((e, i) => i < 4 || owns('emote:' + e));
  }
  function devType(dev) { return dev ? ((C().deviceTypes || {})[dev.type] || { name: dev.type, icon: '❔' }) : null; }

  /* ------------------------------------------------------------------
     8. Netzwerk
     ------------------------------------------------------------------ */
  const socket = io();

  socket.on('connect', () => {
    show('#connBanner', false);
    const wasConnected = S.connectedOnce;
    S.connectedOnce = true;
    if (S.account) autoLogin(wasConnected);
    else { hideLoading(); setView('setup'); }
  });
  socket.on('disconnect', () => {
    if (S.connectedOnce) show('#connBanner', true);
    S.loggedIn = false;
    S.input.x = 0; S.input.y = 0;
  });
  socket.on('connect_error', () => {
    if (!S.connectedOnce) setTimeout(() => { if (!S.connectedOnce) { hideLoading(); show('#connBanner', true); } }, 4000);
  });
  socket.on('catalog', (cat) => {
    S.catalog = cat || {};
    safe(() => Render.setCatalog(S.catalog));
    measureAvatar();
    if (S.view === 'home') renderHome();
    if (S.view === 'lobby') renderLobby();
  });
  socket.on('rooms', (list) => { S.rooms = Array.isArray(list) ? list : []; renderRoomList(); });
  socket.on('room', onRoom);
  socket.on('world', onWorld);
  socket.on('snap', onSnap);
  socket.on('ev', (list) => { if (Array.isArray(list)) list.forEach((e) => { try { onEvent(e); } catch (err) { console.warn('Event-Fehler', e && e.e, err); } }); });
  socket.on('results', onResults);
  socket.on('profile', (p) => setProfile(p));

  function emitAck(name, data) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, msg: 'Keine Antwort vom Server – bitte nochmal versuchen.' }); } }, 8000);
      socket.emit(name, data || {}, (res) => { if (done) return; done = true; clearTimeout(t); resolve(res || { ok: false, msg: 'Unbekannter Fehler.' }); });
    });
  }

  /* ------------------------------------------------------------------
     9. Konto / Spieler-Ausweis
     ------------------------------------------------------------------ */
  function setProfile(p) {
    if (!p) return;
    S.profile = p;
    store('sl_profile', p);
    if (S.account && p.code && !S.account.code) { S.account.code = p.code; store('sl_account', S.account); }
    refreshProfileUI();
  }
  function refreshProfileUI() {
    if (S.view === 'home') renderHome();
    if (S.sheet) renderSheet();
    $('#sheetCoins').textContent = '🪙 ' + ((S.profile && S.profile.coins) || 0);
  }
  async function autoLogin(isReconnect) {
    const acc = S.account;
    let res = await emitAck('account:login', { name: acc.name, code: acc.code });
    if (!res.ok) {
      const backup = load('sl_profile', null);
      const restore = backup && backup.name && backup.name.toLowerCase() === acc.name.toLowerCase() ? backup : null;
      const reg = await emitAck('account:register', { name: acc.name, code: acc.code, avatar: restore ? restore.avatar : randomFreeAvatar(), restore });
      if (reg.ok) res = reg;
    }
    hideLoading();
    if (!res.ok) {
      setView('setup');
      showLoadForm(true);
      $('#loadName').value = acc.name || '';
      $('#loadCode').value = acc.code || '';
      $('#loadErr').textContent = res.msg || 'Anmeldung fehlgeschlagen.';
      return;
    }
    afterLogin(res.profile, isReconnect);
  }
  function afterLogin(profile, isReconnect) {
    S.loggedIn = true;
    setProfile(profile);
    if (S.roomCode && isReconnect) { joinRoom(S.roomCode, true); return; }
    if (S.pendingRoom) { const c = S.pendingRoom; S.pendingRoom = null; joinRoom(c); return; }
    if (!S.room) setView('home');
  }
  function saveAccount(name, code) {
    S.account = { name, code };
    store('sl_account', S.account);
  }
  function showLoadForm(on) {
    show('#setupNew', !on);
    show('#setupLoad', on);
  }
  function checkSetupCode() {
    const inp = $('#setupCode');
    const v = inp.value.replace(/\D/g, '').slice(0, 4);
    if (inp.value !== v) inp.value = v;
    const p = v.length === 4 ? codeProblem(v) : null;
    inp.classList.toggle('ok', v.length === 4 && !p);
    inp.classList.toggle('bad', !!p);
    $('#setupHint').textContent = p || (v.length === 4 ? '✔ Guter Code! Merk ihn dir gut.' : 'Wähle selbst 4 Ziffern oder nimm den Vorschlag. Einfache Folgen wie 1234 oder 0000 sind nicht erlaubt.');
  }
  async function doRegister() {
    const name = $('#setupName').value.trim();
    const code = $('#setupCode').value.trim();
    const np = nameProblem(name);
    if (np) { $('#setupErr').textContent = np; Sfx.play('error'); return; }
    const cp = codeProblem(code);
    if (cp) { $('#setupErr').textContent = cp; Sfx.play('error'); return; }
    $('#setupErr').textContent = '';
    $('#setupGo').disabled = true;
    const res = await emitAck('account:register', { name, code, avatar: randomFreeAvatar() });
    $('#setupGo').disabled = false;
    if (!res.ok) { $('#setupErr').textContent = res.msg || 'Das hat nicht geklappt.'; Sfx.play('error'); return; }
    saveAccount(name, code);
    Sfx.play('fanfare');
    Voice.say('Willkommen bei Streiche Alarm, ' + name + '!');
    afterLogin(res.profile, false);
  }
  async function doLoad() {
    const name = $('#loadName').value.trim();
    const code = $('#loadCode').value.replace(/\D/g, '').slice(0, 4);
    if (nameProblem(name)) { $('#loadErr').textContent = nameProblem(name); return; }
    if (code.length !== 4) { $('#loadErr').textContent = 'Bitte den 4-stelligen Code eingeben.'; return; }
    $('#loadErr').textContent = '';
    $('#loadGo').disabled = true;
    const res = await emitAck('account:login', { name, code });
    $('#loadGo').disabled = false;
    if (!res.ok) { $('#loadErr').textContent = res.msg || 'Name oder Code stimmt nicht.'; Sfx.play('error'); return; }
    saveAccount(res.profile && res.profile.name ? res.profile.name : name, code);
    Sfx.play('fanfare');
    toast('🔓 Spielstand geladen – willkommen zurück, ' + (res.profile.name || name) + '!', 'good');
    afterLogin(res.profile, false);
  }
  async function logout() {
    const ok = await confirmBox('Abmelden? Merk dir vorher Name & Code, damit du deinen Spielstand wieder laden kannst!', 'Abmelden', 'Doch nicht');
    if (!ok) return;
    if (S.room) await leaveRoom(true);
    store('sl_account', null);
    store('sl_profile', null);
    S.account = null; S.profile = null; S.loggedIn = false;
    socket.disconnect(); socket.connect();
    setView('setup');
    showLoadForm(true);
  }

  /* ------------------------------------------------------------------
     10. Ansichten
     ------------------------------------------------------------------ */
  function hideLoading() {
    const l = $('#loading');
    if (!l || l.classList.contains('gone')) return;
    l.classList.add('gone');
    setTimeout(() => l.remove(), 450);
  }
  function setView(v) {
    S.view = v;
    show('#scr-setup', v === 'setup');
    show('#scr-home', v === 'home');
    show('#scr-lobby', v === 'lobby');
    const inWorld = v === 'lobby' || v === 'game';
    show('#hud', inWorld);
    $('#hud').classList.toggle('practice', v === 'lobby');
    document.body.classList.toggle('in-world', inWorld);
    if (!inWorld) { closeWheel(); show('#buildBar', false); }
    if (v === 'setup') {
      if (!$('#setupCode').value) { $('#setupCode').value = suggestCode(); }
      checkSetupCode();
    }
    if (v === 'home') renderHome();
    if (v === 'lobby') renderLobby();
    updateControlsVisibility();
  }
  function updateControlsVisibility() {
    const lobbyOpen = S.view === 'lobby' && !S.lobbyCollapsed;
    const vis = (S.view === 'game' && !S.spectator && !S.resultsOpen) ||
      (S.view === 'lobby' && !!S.world && (!lobbyOpen || !isTouch));
    show('#controls', vis);
    if (!vis) { resetJoystick(); show('#emojiBar', false); }
    document.body.classList.toggle('lobby-open', lobbyOpen);
    document.body.classList.toggle('lobby-closed', S.view === 'lobby' && S.lobbyCollapsed);
    document.body.classList.toggle('side-layout', !!sideLayoutMQ.matches);
    document.body.classList.toggle('tapmode', isTouch && S.settings.controls === 'tap');
    document.body.classList.toggle('desk', !isTouch);
  }

  /* ------------------------------------------------------------------
     11. Startseite
     ------------------------------------------------------------------ */
  function renderHome() {
    const p = S.profile;
    if (!p) return;
    $('#chipName').textContent = p.name;
    $('#chipLevel').textContent = 'Lvl ' + (p.level || 1);
    $('#chipCoins').textContent = '🪙 ' + (p.coins || 0);
    $('#ausweisName').textContent = p.name;
    $('#ausweisCode').textContent = (S.account && S.account.code) || p.code || '····';
    $('#ausweisLevel').textContent = 'Level ' + (p.level || 1);
    const need = p.xpNext || C().xpPerLevel || 150;
    const xp = p.xp || 0;
    $('#ausweisXpBar').style.width = clamp(xp / need * 100, 0, 100) + '%';
    $('#ausweisXpText').textContent = xp + ' / ' + need + ' XP';
    drawAvatarFit($('#chipAvatar'), p.avatar, 44, 44, { crop: 'bust', pad: 0.02 });
    drawAvatarFit($('#ausweisAvatar'), p.avatar, 100, 110, { pad: 0.07 });
    const dl = (p.daily && p.daily.list) || [];
    show('#dailyBadge', dl.some((d) => !d.done));
    renderRoomList();
  }
  function renderRoomList() {
    const box = $('#roomList');
    if (!box) return;
    box.innerHTML = '';
    const list = (S.rooms || []).slice().sort((a, b) => (a.state === 'lobby' ? 0 : 1) - (b.state === 'lobby' ? 0 : 1));
    if (!list.length) {
      box.appendChild(h('div', { class: 'room-empty' }, '🦗 Gerade keine offenen Räume – erstelle einen und hol deine Freunde per WhatsApp!'));
      return;
    }
    list.forEach((r) => {
      const mode = (C().modes || {})[r.mode] || {};
      const bld = (C().buildings || {})[r.building] || {};
      const waiting = r.state === 'lobby';
      const full = r.count >= (r.max || 6);
      const txt = waiting
        ? genitive(r.host || 'Unbekannt') + ' Raum – ' + (full ? 'voll' : 'wartet auf Spieler') + ' (' + r.count + '/' + (r.max || 6) + ')'
        : genitive(r.host || 'Unbekannt') + ' Raum – Runde läuft (' + r.count + '/' + (r.max || 6) + ')';
      const item = h('button', {
        class: 'room-item' + (waiting && !full ? '' : ' busy'), type: 'button',
        onclick: () => joinRoom(r.code)
      },
      h('span', { class: 'ri-ico' }, mode.icon || '🎭'),
      h('span', { class: 'ri-text' }, h('b', null, txt), h('small', null, (mode.name || '') + ' · ' + (bld.icon || '') + ' ' + (bld.short || bld.name || '') + ' · Code ' + r.code)),
      h('span', { class: 'ri-go' }, waiting && !full ? 'Rein!' : 'Zuschauen'));
      box.appendChild(item);
    });
  }

  /* ------------------------------------------------------------------
     12. Räume
     ------------------------------------------------------------------ */
  async function createRoom() {
    if (!S.loggedIn) { toast('Einen Moment – verbinde mit dem Server …', 'bad'); return; }
    $('#btnCreate').disabled = true;
    const res = await emitAck('room:create', {});
    $('#btnCreate').disabled = false;
    if (!res.ok) { $('#homeErr').textContent = res.msg || 'Raum konnte nicht erstellt werden.'; Sfx.play('error'); return; }
    S.roomCode = res.code;
    Sfx.play('fanfare');
    setTimeout(() => { if (!S.room || S.room.code !== res.code) joinRoom(res.code, true); }, 400);
  }
  async function joinRoom(code, quiet) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length !== 4) { $('#homeErr').textContent = 'Der Raum-Code hat 4 Zeichen.'; Sfx.play('error'); return; }
    if (!S.loggedIn) { S.pendingRoom = code; return; }
    const res = await emitAck('room:join', { code });
    if (!res.ok) {
      if (S.room && S.room.code === code) return;
      if (!quiet || S.view !== 'lobby') {
        $('#homeErr').textContent = res.msg || 'Beitritt fehlgeschlagen.';
        toast('🚪 ' + (res.msg || 'Beitritt fehlgeschlagen.'), 'bad');
        Sfx.play('error');
      }
      if (!S.room) { S.roomCode = null; setUrlRoom(null); if (S.view !== 'home') setView('home'); }
      return;
    }
    S.roomCode = res.code || code;
    $('#homeErr').textContent = '';
    setUrlRoom(S.roomCode);
  }
  async function leaveRoom(silent) {
    await emitAck('room:leave', {});
    S.room = null; S.roomCode = null; S.world = null; S.me = null; S.snaps = []; S.pred = null;
    S.resultsOpen = false;
    show('#scr-results', false);
    safe(() => Render.clearWorld());
    setUrlRoom(null);
    if (!silent) setView('home');
  }
  function setUrlRoom(code) {
    try {
      const u = new URL(location.href);
      if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
      history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
    } catch (e) { /* egal */ }
  }
  function onRoom(r) {
    if (!r) return;
    const prev = S.room;
    S.room = r;
    S.roomCode = r.code;
    S.myId = r.you || S.myId;
    (r.players || []).forEach((p) => {
      S.players[p.id] = Object.assign(S.players[p.id] || {}, p);
    });
    if (r.state === 'lobby') {
      if (S.resultsOpen) closeResults();
      if (S.view !== 'lobby') { S.lobbyCollapsed = false; applyLobbyCollapse(); setView('lobby'); }
      else renderLobby();
    } else if (r.state === 'playing') {
      if (S.view !== 'game' && S.world && !S.world.practice) setView('game');
      renderLobby();
    } else {
      renderLobby();
    }
    if (!prev) setUrlRoom(r.code);
  }

  /* ------------------------------------------------------------------
     13. Lobby
     ------------------------------------------------------------------ */
  function isHost() { return !!(S.room && S.room.host && S.room.host === S.room.you); }
  function renderLobby() {
    const r = S.room;
    if (!r || !$('#scr-lobby')) return;
    const cat = C();
    const host = isHost();
    const st = r.settings || {};
    $('#lobbyCode').textContent = r.code;
    const players = r.players || [];
    const max = r.max || 6;
    $('#lobbyCount').textContent = players.length + '/' + max;
    $('#lobbyToggleText').textContent = '🎭 Raum ' + r.code + ' · ' + players.length + '/' + max + (host ? ' · Start ▶' : '');
    const link = location.origin + '/?room=' + r.code;
    const waText = '🎭 Streiche Alarm! Komm in ' + genitive((S.profile && S.profile.name) || 'meinen') + ' Raum ' + r.code +
      ' – Fallen stellen, Chaos & Schadenfreude! 😂☕🤕\n👉 ' + link;
    $('#btnWhatsApp').href = 'https://wa.me/?text=' + encodeURIComponent(waText);
    $('#btnWhatsApp').dataset.text = waText;

    // Spielerliste
    const pl = $('#lobbyPlayers');
    pl.innerHTML = '';
    players.forEach((p) => {
      const isMe = p.id === r.you;
      const cv = h('canvas', { width: 100, height: 100 });
      const team = st.mode === 'teams' && p.team !== undefined && p.team !== null && p.team >= 0 ? teamInfo(p.team) : null;
      const teamEl = team ? h('button', {
        class: 'lp-team', type: 'button', style: 'background:' + team.color, disabled: !host,
        onclick: () => { if (host) emitAck('room:team', { id: p.id, team: p.team === 0 ? 1 : 0 }).then(failToast); }
      }, team.name) : null;
      pl.appendChild(h('div', { class: 'lp' + (isMe ? ' me' : '') }, cv,
        h('div', { class: 'lp-name' },
          h('b', null, (p.id === r.host ? '👑 ' : '') + p.name + (isMe ? ' (Du)' : '')),
          h('small', null, p.bot ? '🤖 KI-Bot' : p.ai ? '📴 getrennt – KI übernimmt' : '⭐ Level ' + (p.level || 1))),
        teamEl));
      drawAvatarFit(cv, p.avatar, 50, 50, { crop: 'bust', pad: 0.02 });
    });
    for (let i = players.length; i < max; i++) {
      pl.appendChild(h('div', { class: 'lp lp-empty' }, i === players.length ? '➕ Freier Platz – lad Freunde ein!' : 'Freier Platz'));
    }
    show('#lobbyBotRow', host);
    $('#botAdd').disabled = players.length >= max;
    $('#botRemove').disabled = !players.some((p) => p.bot);

    // Modi
    const mc = $('#modeCards');
    mc.innerHTML = '';
    const modes = cat.modes || {};
    Object.keys(modes).filter((id) => isSelectable(id, modes[id])).forEach((id) => {
      const m = modes[id];
      mc.appendChild(h('button', {
        class: 'mode-card' + (st.mode === id ? ' sel' : ''), type: 'button', disabled: !host,
        onclick: () => setRoomSetting({ mode: id })
      }, h('span', { class: 'mc-ico' }, m.icon || '🎲'), h('b', null, m.name || id), h('small', null, m.desc || '')));
    });

    // Gebäude
    const bc = $('#buildingCards');
    bc.innerHTML = '';
    const blds = cat.buildings || {};
    Object.keys(blds).filter((id) => isSelectable(id, blds[id])).forEach((id) => {
      const b = blds[id];
      const unlocked = !b.price || owns('bld:' + id) || st.party;
      bc.appendChild(h('button', {
        class: 'bld-card' + (st.building === id ? ' sel' : '') + (unlocked ? '' : ' locked'), type: 'button', disabled: !host,
        onclick: () => {
          if (!unlocked) { toast('🔒 ' + (b.name || id) + ' gibt es im Prank-Shop (' + (b.price || '?') + ' 🪙) – oder Party-Modus einschalten!', 'bad'); Sfx.play('error'); return; }
          setRoomSetting({ building: id });
        }
      }, h('span', { class: 'mc-ico' }, b.icon || '🏢'), h('b', null, b.short || b.name || id), h('small', null, unlocked ? (b.desc || '') : '🔒 ' + (b.price || 0) + ' 🪙 im Shop')));
    });

    // Dauer, Fallen-Regel, Party
    show('#durationRow', st.mode === 'chaos');
    $$('#durationSeg button').forEach((b) => { b.classList.toggle('sel', String(st.duration || 3) === b.dataset.val); b.disabled = !host; });
    $$('#trapRuleSeg button').forEach((b) => { b.classList.toggle('sel', (st.trapRule || 'schnell') === b.dataset.val); b.disabled = !host; });
    const items = cat.items || {};
    $('#trapRuleHint').textContent = (st.trapRule === 'items')
      ? 'Sammel-Items (' + Object.keys(items).map((k) => items[k].icon).join(' ') + ') liegen im Gebäude herum. Passt ein Item zur Falle, wird sie zur Kombo-Falle: länger & doppelte Punkte!'
      : 'Schnell-Sabotage: Fallen direkt aus dem Rad bauen – ohne Sammel-Items.';
    $('#partyToggle').checked = !!st.party;
    $('#partyToggle').disabled = !host;

    const modeMin = (modes[st.mode] && modes[st.mode].min) || 2;
    const note = host
      ? (players.length < modeMin ? 'Zu wenige Spieler? Fehlende Plätze füllt der Start automatisch mit Bots auf (' + (modes[st.mode] ? modes[st.mode].name : '') + ' braucht ' + modeMin + ').' : 'Alle da? Dann los!')
      : '⏳ Warte, bis ' + ((S.players[r.host] && S.players[r.host].name) || 'der Host') + ' die Runde startet …';
    $('#lobbyHostNote').textContent = note;
    show('#btnStart', host);
    $('#btnStart').disabled = r.state !== 'lobby';
  }
  /** Interne Einträge (z. B. der Übungsplatz) nicht zur Auswahl anbieten */
  function isSelectable(id, o) { return !!o && o.selectable !== false && id !== 'uebung'; }
  function failToast(res) { if (res && !res.ok) { toast(res.msg || 'Das ging nicht.', 'bad'); Sfx.play('error'); } }
  function setRoomSetting(part) {
    if (!isHost()) return;
    Sfx.play('klick');
    emitAck('room:settings', part).then(failToast);
  }
  function applyLobbyCollapse() {
    $('#lobbyPanel').classList.toggle('collapsed', S.lobbyCollapsed);
    $('#lobbyToggleArrow').textContent = S.lobbyCollapsed ? (sideLayoutMQ.matches ? '▶' : '▲') : (sideLayoutMQ.matches ? '◀' : '▼');
    updateControlsVisibility();
  }

  /* ------------------------------------------------------------------
     14. Welt & Snapshots
     ------------------------------------------------------------------ */
  function onWorld(w) {
    if (!w || !w.map) return;
    S.world = w;
    S.practice = !!w.practice;
    S.spectator = !!w.spectator;
    S.myId = w.you || S.myId;
    (w.players || []).forEach((p) => { S.players[p.id] = Object.assign(S.players[p.id] || {}, p); });
    S.devById = {}; (w.map.devices || []).forEach((d) => { S.devById[d.id] = d; });
    S.hideById = {}; (w.map.hides || []).forEach((d) => { S.hideById[d.id] = d; });
    buildSolid(w.map);
    S.snaps = []; S.lastSnap = null; S.me = null; S.pred = null; S.cam = null; S.target = null;
    S.steps = []; S.stepsSeen = {}; S.tl = null; S.followId = null; S.offset = null;
    S.hudKeys = {};
    closeWheel();
    safe(() => Render.setWorld(w));
    safe(() => Render.resize());
    if (S.resultsOpen && S.practice) closeResults();
    if (S.practice) { if (S.view !== 'lobby') setView('lobby'); }
    else { setView('game'); }
    show('#specBanner', S.spectator);
    updateControlsVisibility();
    resizeMinimap();
  }
  function buildSolid(map) {
    const W = map.w, H = map.h;
    const s = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { const t = map.tiles[i]; s[i] = (t === 0 || t === 2 || t === 4) ? 1 : 0; }
    const types = C().deviceTypes || {};
    (map.devices || []).forEach((d) => { if (!(types[d.type] && types[d.type].mobile) && d.type !== 'saugroboter') s[d.y * W + d.x] = 1; });
    (map.hides || []).forEach((d) => { s[d.y * W + d.x] = 1; });
    (map.decor || []).forEach((d) => { s[d.y * W + d.x] = 1; });
    S.solid = { W, H, s };
  }
  function isSolid(i, j) {
    const g = S.solid;
    if (!g || i < 0 || j < 0 || i >= g.W || j >= g.H) return true;
    return g.s[j * g.W + i] === 1;
  }
  function collides(x, y, r) {
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        if (!isSolid(i, j)) continue;
        const cx = clamp(x, i, i + 1), cy = clamp(y, j, j + 1);
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }
  function moveCollide(p, dx, dy) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.08));
    const sx = dx / steps, sy = dy / steps;
    for (let k = 0; k < steps; k++) {
      if (!collides(p.x + sx, p.y, R_PLAYER)) p.x += sx;
      if (!collides(p.x, p.y + sy, R_PLAYER)) p.y += sy;
    }
  }

  function onSnap(s) {
    if (!s || !S.world) return;
    const t = now();
    const off = s.t - t;
    if (S.offset === null || Math.abs(off - S.offset) > 800) S.offset = off;
    else S.offset += (off - S.offset) * 0.06;
    S.snaps.push(s);
    while (S.snaps.length > 2 && (S.snaps.length > 40 || s.t - S.snaps[0].t > 1500)) S.snaps.shift();
    S.lastSnap = s;
    if (s.tl !== null && s.tl !== undefined) { S.tl = s.tl; S.tlAt = t; } else S.tl = null;
    S.spectator = !!s.spec;
    if (s.me) {
      S.me = s.me;
      if (!S.pred) { S.pred = { x: s.me.x, y: s.me.y }; S.cam = { x: s.me.x, y: s.me.y }; }
      if (S.target && Math.hypot(s.me.x - S.target.x, s.me.y - S.target.y) < 0.9) S.target = null;
    } else {
      S.me = null;
    }
    if (s.follow && !S.followManual) S.followId = s.follow;
    // Schallwellen (gedrosselt pro Ort)
    (s.steps || []).forEach((st) => {
      const key = Math.round(st[0] * 1.5) + ',' + Math.round(st[1] * 1.5);
      if (S.stepsSeen[key] && t - S.stepsSeen[key] < 450) return;
      S.stepsSeen[key] = t;
      S.steps.push({ x: st[0], y: st[1], t });
    });
    if (S.steps.length > 60) S.steps.splice(0, S.steps.length - 60);
    updateHud(s);
  }

  function interpEntities(t) {
    const snaps = S.snaps;
    if (!snaps.length) return [];
    const rt = t + (S.offset || 0) - INTERP_DELAY;
    let a = null, b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].t <= rt) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    }
    if (!a) { a = snaps[0]; b = null; }
    const base = b || a;
    const alpha = b ? clamp((rt - a.t) / Math.max(1, b.t - a.t), 0, 1) : 0;
    const byId = {};
    if (b) (a.e || []).forEach((e) => { byId[e.id] = e; });
    const cat = C();
    const out = [];
    (base.e || []).forEach((e) => {
      const o = Object.assign({}, e);
      const pa = byId[e.id];
      if (pa) {
        o.x = lerp(pa.x, e.x, alpha);
        o.y = lerp(pa.y, e.y, alpha);
        let dd = (e.d || 0) - (pa.d || 0);
        while (dd > Math.PI) dd -= Math.PI * 2;
        while (dd < -Math.PI) dd += Math.PI * 2;
        o.d = (pa.d || 0) + dd * alpha;
      }
      if (e.k === 'p') {
        const p = S.players[e.id] || {};
        o.name = p.name || '???';
        o.avatar = p.avatar || null;
        o.team = (e.tm !== undefined && e.tm !== null) ? e.tm : (p.team !== undefined ? p.team : -1);
        o.bot = !!p.bot;
      } else if (e.k === 'n') {
        const nt = (cat.npcTypes || {})[e.npc] || {};
        o.avatar = nt.look || null;
        o.label = nt.name || 'Passant';
        o.team = -1;
      }
      out.push(o);
    });
    return out;
  }

  /* ------------------------------------------------------------------
     15. Eingabe: Tastatur, Joystick, Tap-to-Walk
     ------------------------------------------------------------------ */
  function typingInField(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }
  const MOVE_KEYS = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
  window.addEventListener('keydown', (e) => {
    if (typingInField(e)) {
      if (e.key === 'Enter') {
        if (e.target.id === 'setupName') $('#setupCode').focus();
        else if (e.target.id === 'setupCode') doRegister();
        else if (e.target.id === 'loadName') $('#loadCode').focus();
        else if (e.target.id === 'loadCode') doLoad();
        else if (e.target.id === 'joinCode') joinRoom($('#joinCode').value);
      }
      return;
    }
    if (e.code === 'Escape') {
      if (S.wheelOpen) { closeWheel(); return; }
      if (!$('#modal').classList.contains('hidden')) { $('#modalNo').click(); return; }
      if (S.sheet) { closeSheet(); return; }
      show('#hudMenu', false); show('#emojiBar', false);
      return;
    }
    const inWorld = S.view === 'game' || S.view === 'lobby';
    if (!inWorld || S.sheet || !$('#modal').classList.contains('hidden')) return;
    // Fokus von angeklickten Buttons lösen, damit Leertaste/Enter nicht doppelt auslösen
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
    if (S.wheelOpen) {
      const n = /^Digit([1-9])$/.exec(e.code) || /^Numpad([1-9])$/.exec(e.code);
      if (n) { e.preventDefault(); pickWheelSlot(Number(n[1])); return; }
      if (e.code === 'KeyF' || e.code === 'KeyQ') { e.preventDefault(); closeWheel(); }
      return;
    }
    if (MOVE_KEYS[e.code]) { S.keys[MOVE_KEYS[e.code]] = true; e.preventDefault(); return; }
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyE': case 'Enter': case 'NumpadEnter': e.preventDefault(); doUse(); break;
      case 'KeyF': case 'KeyQ': e.preventDefault(); openWheel(); break;
      case 'Space': e.preventDefault(); doHide(); break;
      case 'KeyV': doDisguise(); break;
      case 'KeyR': doWave(); break;
      case 'KeyM': toggleMinimap(); break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': {
        const em = emotesOwned()[Number(e.code.slice(5)) - 1];
        if (em) sendEmoji(em);
        break;
      }
      default: break;
    }
  });
  window.addEventListener('keyup', (e) => { if (MOVE_KEYS[e.code]) S.keys[MOVE_KEYS[e.code]] = false; });
  window.addEventListener('blur', () => { S.keys = {}; resetJoystick(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { S.keys = {}; resetJoystick(); sendInputNow(0, 0); }
  });

  // Joystick (dynamisch: erscheint dort, wo der Daumen aufsetzt)
  const JOY_R = 58;
  function resetJoystick() {
    S.joy.active = false; S.joy.id = null; S.joy.vx = 0; S.joy.vy = 0;
    show('#joyBase', false);
  }
  (function setupJoystick() {
    const zone = $('#joyZone');
    zone.addEventListener('pointerdown', (e) => {
      if (S.joy.active) return;
      e.preventDefault();
      S.joy.active = true; S.joy.id = e.pointerId; S.joy.bx = e.clientX; S.joy.by = e.clientY; S.joy.vx = 0; S.joy.vy = 0;
      try { zone.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
      const base = $('#joyBase');
      base.style.left = e.clientX + 'px'; base.style.top = e.clientY + 'px';
      $('#joyKnob').style.transform = 'translate(0px,0px)';
      show(base, true);
      show('#emojiBar', false);
    });
    zone.addEventListener('pointermove', (e) => {
      if (!S.joy.active || e.pointerId !== S.joy.id) return;
      e.preventDefault();
      let dx = e.clientX - S.joy.bx, dy = e.clientY - S.joy.by;
      const len = Math.hypot(dx, dy);
      if (len > JOY_R * 1.6) { // Basis zieht mit, wenn der Daumen weit wegrutscht
        const k = (len - JOY_R * 1.6) / len;
        S.joy.bx += dx * k; S.joy.by += dy * k;
        const base = $('#joyBase');
        base.style.left = S.joy.bx + 'px'; base.style.top = S.joy.by + 'px';
        dx = e.clientX - S.joy.bx; dy = e.clientY - S.joy.by;
      }
      const l2 = Math.hypot(dx, dy);
      const cl = Math.min(l2, JOY_R);
      const kx = l2 ? dx / l2 * cl : 0, ky = l2 ? dy / l2 * cl : 0;
      $('#joyKnob').style.transform = 'translate(' + kx + 'px,' + ky + 'px)';
      const mag = clamp((l2 / JOY_R - 0.14) / 0.66, 0, 1);
      S.joy.vx = l2 ? dx / l2 * mag : 0;
      S.joy.vy = l2 ? dy / l2 * mag : 0;
    });
    const end = (e) => { if (e.pointerId === S.joy.id) resetJoystick(); };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
  })();

  function currentInput() {
    if (S.wheelOpen || S.sheet || !S.me || S.spectator || (S.view !== 'game' && S.view !== 'lobby')) return { x: 0, y: 0 };
    let sx = 0, sy = 0;
    if (S.keys.l) sx -= 1;
    if (S.keys.r) sx += 1;
    if (S.keys.u) sy -= 1;
    if (S.keys.d) sy += 1;
    let mag = 0;
    if (sx || sy) { const l = Math.hypot(sx, sy); sx /= l; sy /= l; mag = 1; }
    else if (S.joy.active && (S.joy.vx || S.joy.vy)) {
      mag = Math.hypot(S.joy.vx, S.joy.vy);
      sx = S.joy.vx / (mag || 1); sy = S.joy.vy / (mag || 1);
    }
    if (!mag) return { x: 0, y: 0 };
    const w = safe(() => Render.screenDirToWorld(sx, sy)) || { x: sx, y: sy };
    const wl = Math.hypot(w.x, w.y) || 1;
    return { x: w.x / wl * mag, y: w.y / wl * mag };
  }
  function sendInputNow(x, y) {
    if (!socket.connected) return;
    socket.emit('input', { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
    S.lastSent = { x, y, t: now() };
  }
  function maybeSendInput(t) {
    const v = S.input;
    const ls = S.lastSent;
    const diff = Math.hypot(v.x - ls.x, v.y - ls.y);
    const moving = Math.hypot(v.x, v.y) > 0.01;
    if (diff > 0.06 && t - ls.t >= 50) sendInputNow(v.x, v.y);
    else if (!moving && Math.hypot(ls.x, ls.y) > 0.01) sendInputNow(0, 0);
    else if (moving && t - ls.t >= 250) sendInputNow(v.x, v.y);
  }

  // Tap/Klick auf die Welt
  (function setupWorldTap() {
    const cv = $('#world');
    let down = null;
    cv.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: now(), id: e.pointerId, type: e.pointerType }; });
    cv.addEventListener('pointerup', (e) => {
      if (!down || down.id !== e.pointerId) return;
      const d = down; down = null;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 14 || now() - d.t > 600) return;
      if (S.view !== 'game' && S.view !== 'lobby') return;
      if (S.wheelOpen) { closeWheel(); return; }
      show('#emojiBar', false); show('#hudMenu', false);
      const touchTap = d.type === 'touch' || d.type === 'pen';
      if (touchTap && S.settings.controls !== 'tap') return; // im Joystick-Modus kein Tap-Laufen
      handleWorldTap(e.clientX, e.clientY);
    });
    cv.addEventListener('wheel', (e) => {
      if (S.view !== 'game' && S.view !== 'lobby') return;
      e.preventDefault();
      S.settings.zoom = clamp((S.settings.zoom || 1) * (e.deltaY > 0 ? 0.9 : 1.1), 0.55, 1.9);
      saveSettingsSoon();
    }, { passive: false });
  })();
  function handleWorldTap(sx, sy) {
    if (S.spectator) { cycleFollow(); return; }
    if (!S.me) return;
    const rect = $('#world').getBoundingClientRect();
    const x = sx - rect.left, y = sy - rect.top;
    const near = S.me.near || {};
    const dev = safe(() => Render.hitDevice(x, y));
    if (dev !== null && dev !== undefined && S.devById[dev]) {
      if (near.dev === dev) { doUse(); return; }
      const d = S.devById[dev];
      moveTo(d.x + 0.5, d.y + 0.5, null);
      return;
    }
    const hide = safe(() => Render.hitHide(x, y));
    if (hide !== null && hide !== undefined && S.hideById[hide]) {
      if (near.hide === hide || S.me.hidden === hide) { doHide(); return; }
      const hd = S.hideById[hide];
      moveTo(hd.x + 0.5, hd.y + 0.5, 'hide');
      return;
    }
    const w = safe(() => Render.screenToWorld(x, y));
    if (w && isFinite(w.x) && isFinite(w.y)) moveTo(w.x, w.y, null);
  }
  function moveTo(x, y, then) {
    S.target = { x, y, t: now() };
    const payload = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    if (then) payload.then = then;
    socket.emit('moveTo', payload);
    Sfx.play('klick');
  }

  /* ------------------------------------------------------------------
     16. Aktionen
     ------------------------------------------------------------------ */
  function act(type, extra) {
    if (!socket.connected) return;
    socket.emit('act', Object.assign({ type }, extra || {}));
  }
  function doUse() {
    if (!S.me || S.spectator) return;
    if (S.me.hidden) { doHide(); return; }
    const n = S.me.near || {};
    if (!(n.exit && S.me.exitOpen) && !n.pickup && (n.dev === null || n.dev === undefined)) {
      if (n.exit) toast('🔒 Der Ausgang ist noch zu – erst ' + (modeName() === 'schatzsuche' ? 'alle Schätze finden' : 'alle Aufgaben erledigen') + '!', 'bad');
      else toast('✋ Hier gibt es nichts zu benutzen – geh näher an ein Gerät.', 'info', 1800);
      Sfx.play('error');
      return;
    }
    act('use');
    pressFx('#btnUse');
  }
  function doHide() {
    if (!S.me || S.spectator) return;
    const n = S.me.near || {};
    if (!S.me.hidden && (n.hide === null || n.hide === undefined)) {
      toast('🙈 Kein Versteck in der Nähe (Spind, Schreibtisch, Vorhang, Karton).', 'info', 1800);
      Sfx.play('error');
      return;
    }
    act('hide');
    pressFx('#btnHide');
  }
  function doWave() {
    if (!S.me || S.spectator) return;
    if ((S.me.waveCd || 0) > 0.05) { toast('👋 Winken lädt noch (' + Math.ceil(S.me.waveCd) + ' s)', 'info', 1400); return; }
    act('wave');
    pressFx('#btnWave');
  }
  function doDisguise() {
    if (!S.me || S.spectator) return;
    if ((S.me.dg || 0) > 0) { toast('🥸 Du bist schon verkleidet!', 'info', 1400); return; }
    if ((S.me.dgCd || 0) > 0.05) { toast('🥸 Verkleidung lädt noch (' + Math.ceil(S.me.dgCd) + ' s)', 'info', 1400); return; }
    act('disguise');
    pressFx('#btnDisguise');
  }
  function sendEmoji(e) {
    act('emoji', { e });
    Sfx.play('plopp');
    show('#emojiBar', false);
  }
  function pressFx(sel) {
    const b = $(sel);
    if (!b) return;
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 120);
  }
  function modeName() { return S.world && !S.practice ? (S.world.mode || (S.world.settings && S.world.settings.mode)) : 'uebung'; }

  function bindAct(sel, fn) {
    const b = $(sel);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    b.addEventListener('click', (e) => { e.preventDefault(); });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  bindAct('#btnUse', doUse);
  bindAct('#btnTrap', () => { openWheel(); });
  bindAct('#btnHide', doHide);
  bindAct('#btnWave', doWave);
  bindAct('#btnDisguise', doDisguise);
  bindAct('#btnEmoji', () => {
    const bar = $('#emojiBar');
    if (!bar.classList.contains('hidden')) { show(bar, false); return; }
    bar.innerHTML = '';
    emotesOwned().forEach((em) => {
      const b = h('button', { type: 'button' }, em);
      b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ev.stopPropagation(); sendEmoji(em); });
      bar.appendChild(b);
    });
    show(bar, true);
  });
  // Tasten-Hinweise für den PC
  [['#btnUse', 'E'], ['#btnTrap', 'F'], ['#btnHide', '␣'], ['#btnWave', 'R'], ['#btnDisguise', 'V'], ['#btnEmoji', '1-4']].forEach((k) => {
    $(k[0]).appendChild(h('span', { class: 'key' }, k[1]));
  });

  /* ------------------------------------------------------------------
     17. Fallen-Auswahlrad
     ------------------------------------------------------------------ */
  async function openWheel() {
    if (S.wheelOpen) { closeWheel(); return; }
    if (!S.me || S.spectator) return;
    if (S.me.hidden) { toast('🙈 Im Versteck kannst du keine Falle bauen.', 'info'); return; }
    const n = S.me.near || {};
    if (n.dev === null || n.dev === undefined) {
      toast('🪤 Geh näher an ein Gerät, um einen Streich vorzubereiten!', 'info', 2000);
      Sfx.play('error');
      return;
    }
    if (S.me.build) { act('cancel'); return; }
    pressFx('#btnTrap');
    const res = await emitAck('act', { type: 'wheel' });
    if (!res.ok) { toast(res.msg || 'Hier geht gerade keine Falle.', 'bad'); Sfx.play('error'); return; }
    showWheel(res);
  }
  function wrapName(name, maxLen) {
    const words = String(name).replace(/-/g, '-\u0001').split(/[\s\u0001]+/).filter(Boolean);
    const lines = [];
    let cur = '';
    words.forEach((w) => {
      const glue = cur && !cur.endsWith('-') ? ' ' : '';
      if ((cur + glue + w).length <= maxLen || !cur) cur = cur + glue + w;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    if (lines.length > 3) { lines.length = 3; lines[2] = lines[2].slice(0, maxLen - 1) + '…'; }
    return lines.map((l) => (l.length > maxLen + 2 ? l.slice(0, maxLen + 1) + '…' : l));
  }
  function showWheel(res) {
    const opts = (res.options || []).slice().sort((a, b) => a.slot - b.slot);
    if (!opts.length) { toast('Für dieses Gerät gibt es keine Streiche.', 'bad'); return; }
    S.wheel = res; S.wheelOpen = true;
    const svg = $('#wheelSvg');
    const NS = 'http://www.w3.org/2000/svg';
    svg.innerHTML = '';
    const n = opts.length;
    const R0 = 64, R1 = 196, step = Math.PI * 2 / n;
    const tierFill = { 1: '#ffe066', 2: '#ffb3d1', 3: '#b9a6ff' };
    const mk = (tag, attrs, txt) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (txt !== undefined) e.textContent = txt; return e; };
    const maxLen = n >= 9 ? 11 : n >= 7 ? 13 : 15;
    opts.forEach((o, i) => {
      const a0 = -Math.PI / 2 + (i - 0.5) * step + 0.012, a1 = -Math.PI / 2 + (i + 0.5) * step - 0.012;
      const am = (a0 + a1) / 2;
      const p = (r, a) => (r * Math.cos(a)).toFixed(2) + ' ' + (r * Math.sin(a)).toFixed(2);
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const d = 'M ' + p(R0, a0) + ' L ' + p(R1, a0) + ' A ' + R1 + ' ' + R1 + ' 0 ' + large + ' 1 ' + p(R1, a1) +
        ' L ' + p(R0, a1) + ' A ' + R0 + ' ' + R0 + ' 0 ' + large + ' 0 ' + p(R0, a0) + ' Z';
      const g = mk('g', { class: 'seg', 'data-slot': o.slot });
      const fill = o.locked ? '#d9d6e6' : (tierFill[o.tier] || '#ffe066');
      g.appendChild(mk('path', { d, class: 'seg-path', fill }));
      const at = (r) => ({ x: r * Math.cos(am), y: r * Math.sin(am) });
      const lines = wrapName(o.name || 'Streich', maxLen);
      const lh = n >= 9 ? 12 : 13.5;
      const icoSize = n >= 9 ? 26 : 30;
      const blockH = icoSize + 4 + lines.length * lh + 13;
      const c = at(n >= 9 ? 132 : 128);
      let y = c.y - blockH / 2;
      g.appendChild(mk('text', { x: c.x.toFixed(1), y: (y + icoSize / 2).toFixed(1), class: 'seg-ico', 'font-size': icoSize }, o.locked ? '🔒' : (o.icon || '🪤')));
      if (o.boost && !o.locked) g.appendChild(mk('text', { x: (c.x + icoSize * 0.7).toFixed(1), y: (y + 6).toFixed(1), 'font-size': 15, 'dominant-baseline': 'central' }, '⭐'));
      y += icoSize + 4;
      lines.forEach((ln) => { g.appendChild(mk('text', { x: c.x.toFixed(1), y: (y + lh / 2).toFixed(1), class: 'seg-name', 'dominant-baseline': 'central', 'font-size': n >= 9 ? 11 : 12.5 }, ln)); y += lh; });
      const sub = o.locked ? (o.price ? o.price + ' 🪙' : 'Shop') : ('⏱ ' + fmtSec(o.time || 1.5));
      g.appendChild(mk('text', { x: c.x.toFixed(1), y: (y + 7).toFixed(1), class: 'seg-time', 'dominant-baseline': 'central' }, sub));
      const nb = at(R1 - 13);
      g.appendChild(mk('circle', { cx: nb.x.toFixed(1), cy: nb.y.toFixed(1), r: 9, fill: '#2b1d5c' }));
      g.appendChild(mk('text', { x: nb.x.toFixed(1), y: nb.y.toFixed(1), class: 'seg-num', 'dominant-baseline': 'central' }, String(o.slot)));
      g.addEventListener('pointerenter', () => wheelHover(o));
      g.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); wheelHover(o); });
      g.addEventListener('pointerup', (e) => { e.preventDefault(); e.stopPropagation(); pickWheelSlot(o.slot); });
      svg.appendChild(g);
    });
    const center = mk('circle', { cx: 0, cy: 0, r: R0 - 6, class: 'center-c' });
    center.addEventListener('pointerup', (e) => { e.preventDefault(); e.stopPropagation(); closeWheel(); });
    svg.appendChild(center);
    wheelHover(null);
    show('#wheel', true);
    Sfx.play('whoosh');
  }
  function wheelHover(o) {
    const dev = (S.wheel && S.wheel.dev) || {};
    const info = $('#wheelInfo');
    $$('#wheelSvg g.seg').forEach((g) => g.classList.toggle('hot', !!o && Number(g.dataset.slot) === o.slot));
    if (!o) {
      info.innerHTML = '<span class="wi-ico">' + esc(dev.icon || '🪤') + '</span>' + esc(dev.name || 'Gerät') + '<span class="wi-x">✖ schließen</span>';
      return;
    }
    const tierName = { 1: 'Basis', 2: 'Profi', 3: 'Meister' }[o.tier] || '';
    info.innerHTML = '<span class="wi-ico">' + esc(o.locked ? '🔒' : (o.icon || '🪤')) + '</span>' + esc(o.name) +
      '<span class="wi-x" style="color:#4a3a8a">' + esc(o.locked ? ('Gesperrt' + (o.price ? ' · ' + o.price + ' 🪙' : '')) : (tierName + ' · ' + fmtSec(o.time || 1.5) + (o.boost ? ' · ⭐ Kombo' : ''))) + '</span>';
  }
  function pickWheelSlot(slot) {
    if (!S.wheelOpen || !S.wheel) return;
    const o = (S.wheel.options || []).find((x) => x.slot === slot);
    if (!o) return;
    if (o.locked) {
      Sfx.play('error');
      const what = slot >= 8 ? 'das 9er-Meisterrad' : 'Rad-Slot ' + slot;
      toast('🔒 „' + o.name + '“ ist gesperrt – schalte ' + what + ' im Prank-Shop frei' + (o.price ? ' (' + o.price + ' 🪙)' : '') + '!', 'bad', 3200);
      return;
    }
    act('trap', { dev: S.wheel.dev.id, slot });
    Sfx.play('build');
    closeWheel();
  }
  function closeWheel() {
    if (!S.wheelOpen && $('#wheel').classList.contains('hidden')) return;
    S.wheelOpen = false; S.wheel = null;
    show('#wheel', false);
  }
  $('#wheel').addEventListener('pointerup', (e) => { if (e.target.id === 'wheel' || e.target.classList.contains('wheel-wrap')) closeWheel(); });

  /* ------------------------------------------------------------------
     18. HUD
     ------------------------------------------------------------------ */
  function setIfChanged(key, el, html) {
    if (S.hudKeys[key] === html) return;
    S.hudKeys[key] = html;
    el.innerHTML = html;
  }
  function updateHud(s) {
    const me = s.me;
    const cat = C();
    const mode = modeName();
    // Modus-Pill
    const m = (cat.modes || {})[mode];
    $('#hudModeIco').textContent = m ? (m.icon || '🎲') : '🏋️';
    $('#hudModeTxt').textContent = m ? (m.name || '') : 'Übung';
    // Ziel
    let goal = '';
    if (!S.practice && me) {
      if (mode === 'checkliste') {
        goal = '<div class="goal-box"><div class="goal-title">Feierabend-Checkliste</div>' +
          (me.tasks || []).map((t) => '<span class="task-chip' + (t.done ? ' done' : '') + '">' + esc(t.icon || '•') + ' ' + esc(t.label) + '</span>').join('') +
          (me.exitOpen ? '<span class="exit-open">🚪 Ausgang offen – raus hier!</span>' : '') + '</div>';
      } else if (mode === 'schatzsuche') {
        const tr = cat.treasures || {};
        goal = '<div class="goal-box"><div class="goal-title">Geheime Items</div>' +
          Object.keys(tr).map((id) => '<span class="treasure-slot' + ((me.treasures || []).indexOf(id) >= 0 ? ' have' : '') + '" title="' + esc(tr[id].name) + '"><span>' + esc(tr[id].icon) + '</span></span>').join('') +
          (me.exitOpen ? '<span class="exit-open">🚪 Ab zum Ausgang!</span>' : '') + '</div>';
      } else if (mode === 'teams') {
        const ts = s.ts || [0, 0];
        const t0 = teamInfo(0), t1 = teamInfo(1);
        const myT = me.team !== undefined && me.team !== null && me.team >= 0 ? teamInfo(me.team) : null;
        goal = '<div class="goal-box"><div class="goal-title">' + (myT ? 'Du bist im ' + esc(myT.name) : 'Team-Sabotage') + '</div><div class="team-score">' +
          '<span style="background:' + t0.color + '">' + (ts[0] || 0) + '</span> : <span style="background:' + t1.color + '">' + (ts[1] || 0) + '</span></div></div>';
      } else {
        goal = '<div class="goal-box"><div class="goal-title">Prank-Punkte</div><span class="score-big">💥 ' + (me.score || 0) + '</span>' +
          ((me.combo || 0) > 1 ? '<span class="schip combo">🔥 Kombo ×' + me.combo + '</span>' : '') + '</div>';
      }
    } else if (S.spectator && !S.practice) {
      goal = '<div class="goal-box"><div class="goal-title">Zuschauer</div>👀 ' + esc((S.players[S.followId] || {}).name || '') + '</div>';
    }
    setIfChanged('goal', $('#hudGoal'), goal);

    // Scoreboard
    const sb = (s.sb || []).slice();
    if (!S.practice && sb.length) {
      if (mode === 'checkliste' || mode === 'schatzsuche') sb.sort((a, b) => (b.prog - a.prog) || (b.score - a.score));
      else sb.sort((a, b) => b.score - a.score);
      const html = sb.map((r) => {
        const dot = mode === 'teams' && r.team >= 0 ? '<span class="sb-dot" style="background:' + teamInfo(r.team).color + '"></span>' : '';
        const val = mode === 'checkliste' ? r.prog + '/4 ✅' : mode === 'schatzsuche' ? r.prog + '/3 💎' : r.score;
        return '<div class="sb-row' + (r.id === S.myId ? ' me' : '') + '"><b>' + dot + (r.bot ? '🤖' : '') + esc(r.name) + '</b><span>' + val + '</span></div>';
      }).join('');
      setIfChanged('sb', $('#scoreboard'), html);
      show('#scoreboard', true);
    } else show('#scoreboard', false);

    // Bedürfnis
    const nb = $('#needBox');
    if (me && me.need) {
      const nd = (cat.needs || {})[me.need] || { label: me.need, icon: '❗' };
      show(nb, true);
      $('#needIcon').textContent = nd.icon;
      $('#needLabel').textContent = me.slow ? nd.label + '! 🐢 Langsam!' : nd.label + ' gesucht!';
      nb.classList.toggle('slow', !!me.slow);
    } else show(nb, false);

    // Status-Chips
    let chips = '';
    if (me) {
      if ((me.boost || 0) > 0) chips += '<span class="schip boost">⚡ Turbo ' + Math.ceil(me.boost) + 's</span>';
      if (me.slow) chips += '<span class="schip slow">🐢 −30 %</span>';
      if ((me.adr || 0) > 0) chips += '<span class="schip adr">💨 Adrenalin ' + Math.ceil(me.adr) + 's</span>';
      if (me.radar && me.radar.length) chips += '<span class="schip adr">📡 Fallen-Radar</span>';
      if ((me.dg || 0) > 0) chips += '<span class="schip dg">🥸 Getarnt ' + Math.ceil(me.dg) + 's</span>';
      if (me.hidden !== null && me.hidden !== undefined) chips += '<span class="schip hid">🙈 Versteckt</span>';
      if (S.practice) chips += '<span class="schip">🏋️ Übungsplatz</span>';
    }
    setIfChanged('chips', $('#statusChips'), chips);
    if (me) $('#chaosBar').style.width = clamp(me.chaos || 0, 0, 100) + '%';
    show('#chaosBox', !!me && !S.practice);
    const held = me && me.held ? me.held : [];
    setIfChanged('held', $('#heldItems'), held.map((it) => '<span title="' + esc(((cat.items || {})[it] || {}).name || it) + '">' + esc(((cat.items || {})[it] || {}).icon || '❔') + '</span>').join(''));

    show('#specBanner', !!S.spectator && !S.practice);
    updateButtons(me);
  }
  function useInfo(me) {
    if (!me) return { ico: '✋', lbl: 'Benutzen', on: false };
    if (me.hidden !== null && me.hidden !== undefined) return { ico: '🙈', lbl: 'Raus', on: true };
    const n = me.near || {};
    if (n.exit && me.exitOpen) return { ico: '🚪', lbl: 'Flucht!', on: true, glow: true };
    if (n.pickup !== null && n.pickup !== undefined) return { ico: '✋', lbl: 'Aufheben', on: true, glow: true };
    if (n.dev !== null && n.dev !== undefined) {
      const d = S.devById[n.dev];
      const dt = devType(d) || { icon: '🔧' };
      const cat = C();
      const needMatch = me.need && cat.needs && cat.needs[me.need] && d && (cat.needs[me.need].types || []).indexOf(d.type) >= 0;
      const taskMatch = d && (me.tasks || []).some((t) => !t.done && t.type === d.type);
      let lbl = 'Benutzen';
      if (modeName() === 'schatzsuche') lbl = 'Durchsuchen';
      if (needMatch) lbl = me.need === 'kaffee' ? 'Trinken' : me.need === 'snack' ? 'Naschen' : 'Gehen';
      else if (taskMatch) lbl = 'Erledigen';
      return { ico: dt.icon || '🔧', lbl, on: true, glow: needMatch || taskMatch };
    }
    if (n.exit) return { ico: '🔒', lbl: 'Zu', on: false };
    return { ico: '✋', lbl: 'Benutzen', on: false };
  }
  function updateButtons(me) {
    const u = useInfo(me);
    const bu = $('#btnUse');
    const key = u.ico + '|' + u.lbl + '|' + u.on + '|' + !!u.glow;
    if (S.hudKeys.use !== key) {
      S.hudKeys.use = key;
      $('.act-ico', bu).textContent = u.ico;
      $('.act-lbl', bu).textContent = u.lbl;
      bu.classList.toggle('off', !u.on);
      bu.classList.toggle('glow', !!u.glow);
    }
    const n = (me && me.near) || {};
    const hidden = !!me && me.hidden !== null && me.hidden !== undefined;
    const building = !!(me && me.build);
    $('#btnTrap').classList.toggle('off', !me || hidden || ((n.dev === null || n.dev === undefined) && !building));
    $('.act-lbl', $('#btnTrap')).textContent = building ? 'Stopp' : 'Falle';
    $('#btnHide').classList.toggle('off', !me || (!hidden && (n.hide === null || n.hide === undefined)));
    $('.act-lbl', $('#btnHide')).textContent = hidden ? 'Raus' : 'Verstecken';
    const wcd = me ? (me.waveCd || 0) : 0;
    $('.cd', $('#btnWave')).style.setProperty('--cd', clamp(wcd / 8 * 100, 0, 100) + '%');
    $('#btnWave').classList.toggle('off', !me || wcd > 0.05);
    const dcd = me ? (me.dgCd || 0) : 0;
    const dg = me ? (me.dg || 0) : 0;
    $('.cd', $('#btnDisguise')).style.setProperty('--cd', clamp(dcd / 30 * 100, 0, 100) + '%');
    $('#btnDisguise').classList.toggle('off', !me || dcd > 0.05 || dg > 0);
    $('.act-lbl', $('#btnDisguise')).textContent = dg > 0 ? Math.ceil(dg) + ' s' : 'Tarnen';
  }
  function frameHud(t) {
    // Timer
    const tp = $('#hudTimer');
    if (S.tl !== null && !S.practice) {
      const left = S.tl - (t - S.tlAt) / 1000;
      const txt = '⏱ <b>' + fmtTime(left) + '</b>';
      if (S.hudKeys.timer !== txt) { S.hudKeys.timer = txt; tp.innerHTML = txt; }
      tp.classList.toggle('urgent', left <= 30);
      show(tp, true);
    } else show(tp, false);
    const me = S.me;
    // Bedürfnis-Balken
    if (me && me.need) {
      const max = me.needMax || 25;
      $('#needBar').style.width = clamp((me.needT || 0) / max * 100, 0, 100) + '%';
    }
    // Bau-/Benutz-Fortschritt
    const bb = $('#buildBar');
    if (me && (me.build || me.use)) {
      const b = me.build || me.use;
      const dev = S.devById[b.dev];
      const dt = devType(dev) || {};
      let label;
      if (me.build) label = '🪤 Baue „' + trapInfo(me.build.trap).name + '“ …';
      else label = (modeName() === 'schatzsuche' ? '🔍 Durchsuche ' : (dt.icon || '✋') + ' Benutze ') + (dt.name || 'Gerät') + ' …';
      if (S.hudKeys.build !== label) { S.hudKeys.build = label; $('#buildLabel').textContent = label; }
      $('#buildFill').style.width = clamp((b.p || 0) * 100, 0, 100) + '%';
      bb.classList.toggle('using', !me.build);
      show('#buildCancel', !!me.build);
      show(bb, true);
    } else show(bb, false);
  }

  // Minimap
  let mmLast = 0;
  function resizeMinimap() {
    const cv = $('#minimap');
    show(cv, !!S.settings.minimap && !S.practice);
  }
  function toggleMinimap() {
    const cv = $('#minimap');
    cv.classList.toggle('big');
    mmLast = 0;
  }
  $('#minimap').addEventListener('click', toggleMinimap);
  function drawMinimap(t) {
    if (t - mmLast < 160) return;
    mmLast = t;
    const cv = $('#minimap');
    if (cv.classList.contains('hidden') || !S.world) return;
    const w = cv.clientWidth || 120, hh = cv.clientHeight || 120;
    const ctx = prepCanvas(cv, w, hh);
    const me = S.me;
    const targets = [];
    const cat = C();
    if (me) {
      const types = {};
      if (me.need && cat.needs && cat.needs[me.need]) (cat.needs[me.need].types || []).forEach((ty) => { types[ty] = cat.needs[me.need].icon; });
      (me.tasks || []).forEach((tk) => { if (!tk.done && !types[tk.type]) types[tk.type] = tk.icon || '•'; });
      Object.keys(S.devById).forEach((id) => {
        const d = S.devById[id];
        if (types[d.type]) targets.push({ x: d.x + 0.5, y: d.y + 0.5, icon: types[d.type] });
      });
    }
    const pos = S.pred || (me ? { x: me.x, y: me.y } : (S.cam || null));
    const ex = S.world.map.exit;
    safe(() => Render.drawMinimap(ctx, w, hh, {
      me: pos ? { x: pos.x, y: pos.y } : null,
      targets: targets.slice(0, 14),
      exit: ex ? { x: ex.x + 0.5, y: ex.y + 0.5, open: !!(me && me.exitOpen) } : null,
      fog: !S.spectator
    }));
  }

  /* ------------------------------------------------------------------
     19. Ereignisse vom Server
     ------------------------------------------------------------------ */
  const NEED_LINES = { kaffee: ['Kaffee! Ich brauche Kaffee!', 'Ohne Kaffee geht gar nix!'], wc: ['Ich muss mal!', 'Wo ist hier das Klo?!'], snack: ['Hunger! Schokolade!', 'Mein Magen knurrt!'] };
  function randOf(a) { return a[Math.floor(Math.random() * a.length)]; }
  function mePos() { return S.pred || (S.me ? { x: S.me.x, y: S.me.y } : { x: 0, y: 0 }); }
  function onEvent(ev) {
    const cat = C();
    const me = mePos();
    switch (ev.e) {
      case 'trap': {
        const tr = trapInfo(ev.trap);
        const isMe = ev.victim === S.myId;
        safe(() => Render.burst(ev.fx || tr.fx || 'pop', ev.x, ev.y, { big: isMe }));
        Sfx.play(FX_SOUND[ev.fx || tr.fx] || 'boing');
        if (isMe) {
          safe(() => Render.shake(0.9));
          const wasCaught = now() - (S.caughtAt || 0) < 2500;
          if (!wasCaught) bigMsg(ev.self ? 'Eigentor! 🤦' : 'Reingetappt! 🤕', 'bad');
          Voice.say(tr.line || 'Autsch!', { prio: 2, pitch: 1.25 });
          if (!ev.self && ev.oname) toast('😵 „' + tr.name + '“ – gelegt von ' + ev.oname + '!', 'bad');
          else if (ev.self && !wasCaught) toast('🤦 Deine eigene Falle „' + tr.name + '“! Merk dir besser, wo du sie gebaut hast …', 'bad', 3200);
          vibrate([70, 40, 140]);
        } else {
          safe(() => Render.floatText((tr.icon || '💥') + ' ' + tr.name, ev.x, ev.y, '#ffffff'));
          if (ev.owner === S.myId && !ev.self) {
            Voice.say('Streiche Alarm!', { prio: 1, pitch: 1.35 });
            setTimeout(() => Sfx.play('lachen'), 250);
            toast('🎯 ' + (ev.vname || 'Jemand') + ' ist in deine Falle „' + tr.name + '“ getappt!', 'fun');
          } else {
            Voice.say(tr.line, { prio: 0, pitch: 1.0 + Math.random() * 0.4 });
          }
        }
        if (ev.boost) safe(() => Render.floatText('⭐ Kombo-Falle!', ev.x, ev.y - 0.6, '#ffd23f'));
        break;
      }
      case 'trapRemote': {
        const tr = trapInfo(ev.trap);
        toast('🎯 Deine Falle „' + tr.name + '“ hat ' + (ev.vname || 'jemanden') + ' erwischt!' + (ev.pts ? ' +' + ev.pts : ''), 'fun', 3000);
        Voice.say('Streiche Alarm!', { prio: 1, pitch: 1.35 });
        Sfx.play('lachen');
        break;
      }
      case 'built': {
        const tr = trapInfo(ev.trap);
        toast('🤫 Falle „' + tr.name + '“ ist scharf!' + (ev.boost ? ' ⭐ Item-Kombo eingebaut!' : ' Merk dir, wo sie ist!'), 'good');
        Sfx.play('armed');
        const d = S.devById[ev.dev];
        safe(() => Render.burst('build', d ? d.x + 0.5 : me.x, d ? d.y + 0.5 : me.y, {}));
        vibrate(30);
        break;
      }
      case 'buildFail': toast('🚫 ' + (ev.msg || 'Falle konnte nicht gebaut werden.'), 'bad'); Sfx.play('error'); break;
      case 'caught': {
        if (ev.id === S.myId) {
          S.caughtAt = now();
          bigMsg('Erwischt! 🚨', 'bad');
          Voice.say('Erwischt!', { prio: 2, pitch: 0.9 });
          safe(() => Render.shake(0.6));
          toast(ev.by === 'npc' ? '🚨 Ein NPC hat dich beim Fallenbauen gesehen!' : '🚨 Ein Mitspieler hat dich auf frischer Tat ertappt!', 'bad', 3000);
          vibrate([100, 50, 100]);
        } else {
          safe(() => Render.floatText('🚨 Erwischt!', ev.x, ev.y, '#ff5a5a'));
          if (ev.name) toast('🚨 ' + ev.name + ' wurde beim Fallenbauen erwischt!', 'fun');
        }
        Sfx.play('alarm');
        break;
      }
      case 'alarm': {
        safe(() => Render.burst('alarm', ev.x, ev.y, {}));
        safe(() => Render.floatText('❗', ev.x, ev.y, '#ff4d4d'));
        if (Math.hypot(ev.x - me.x, ev.y - me.y) < 10) Voice.say('Hey! Was machen Sie da?!', { prio: 1, pitch: 0.75, rate: 1.1 });
        break;
      }
      case 'need': {
        Sfx.play('need');
        Voice.say(randOf(NEED_LINES[ev.need] || ['Ich brauch was!']), { prio: 0 });
        const nd = (cat.needs || {})[ev.need];
        if (nd) safe(() => Render.floatText(nd.icon + '?', me.x, me.y, '#ffffff'));
        break;
      }
      case 'needDone': {
        Sfx.play(ev.need === 'kaffee' ? 'slurp' : ev.need === 'wc' ? 'splash' : 'plopp');
        safe(() => Render.floatText('⚡ Turbo!', me.x, me.y, '#ffd23f'));
        safe(() => Render.burst('sparkle', me.x, me.y, {}));
        toast('😌 Ahh, besser! ⚡ ' + (ev.boost || 5) + ' Sekunden Turbo!', 'good', 1800);
        break;
      }
      case 'needSlow': {
        const nd = (cat.needs || {})[ev.need] || {};
        toast('🐢 Zu lange gewartet – du bist langsamer, bis du ' + (nd.icon || '') + ' ' + (nd.label || 'es') + ' erledigst!', 'bad', 3000);
        Sfx.play('error');
        break;
      }
      case 'task': toast('✅ ' + (ev.icon || '') + ' ' + ev.label + ' erledigt!' + (ev.left ? ' Noch ' + ev.left + '.' : ''), 'good'); Sfx.play('ding'); safe(() => Render.burst('sparkle', me.x, me.y, {})); break;
      case 'allTasks': bigMsg('Ab zum Ausgang! 🚪', 'good'); Voice.say('Alles erledigt! Ab zum Ausgang!', { prio: 1 }); Sfx.play('fanfare'); break;
      case 'search': if (!ev.found) { toast('🔍 Leer – hier ist nichts versteckt.', 'info', 1600); Sfx.play('plopp'); } break;
      case 'treasure': {
        const tr = (cat.treasures || {})[ev.id] || { icon: '💎', name: ev.name };
        bigMsg(tr.icon + ' ' + (ev.name || tr.name) + '!', 'good');
        Sfx.play('pickup');
        Voice.say('Gefunden! ' + (ev.name || tr.name) + '!', { prio: 1 });
        safe(() => Render.burst('sparkle', me.x, me.y, {}));
        break;
      }
      case 'treasureLost': {
        const tr = (cat.treasures || {})[ev.id] || { icon: '💎' };
        toast('😱 ' + tr.icon + ' ' + (ev.name || 'Item') + ' verloren – es ist jetzt woanders versteckt!', 'bad', 3000);
        break;
      }
      case 'allTreasures': bigMsg('Alle 3! Ab zum Ausgang! 🚪', 'good'); Voice.say('Alle drei! Schnell zum Ausgang!', { prio: 1 }); Sfx.play('fanfare'); break;
      case 'pickup': {
        const it = (cat.items || {})[ev.item] || { icon: '✨', name: ev.item };
        toast(it.icon + ' ' + it.name + ' eingesammelt – verstärkt passende Fallen!', 'good', 2000);
        Sfx.play('pickup');
        break;
      }
      case 'points': safe(() => Render.floatText('+' + ev.pts, ev.x, ev.y, '#ffd23f')); Sfx.play('coins'); break;
      case 'combo': toast('🔥 Kombo ×' + (ev.mult || ev.n) + '!', 'fun', 1800); Voice.say('Kombo!', { prio: 0, pitch: 1.4 }); break;
      case 'schadenfreude': toast('😈 Schadenfreude! +' + ev.pts + (ev.vname ? ' (' + ev.vname + ')' : ''), 'fun', 2200); setTimeout(() => Sfx.play('lachen'), 400); break;
      case 'adrenalin': bigMsg('Adrenalin! 💨', 'good'); Voice.say('Adrenalin-Schub!', { prio: 1 }); toast('💨 Pechsträhne vorbei: Sprint + Fallen-Radar!', 'good'); Sfx.play('whoosh'); break;
      case 'hide': Sfx.play('whoosh'); if (ev.on) toast('🙈 Versteckt – niemand sieht dich.', 'info', 1400); break;
      case 'disguise':
        Sfx.play('whoosh');
        if (ev.on) { toast('🥸 Verkleidet als ' + (ev.name || 'NPC') + ' – NPCs schöpfen keinen Verdacht!', 'good'); safe(() => Render.burst('smoke', me.x, me.y, {})); }
        else toast('🥸 Deine Verkleidung ist weg!', 'info');
        break;
      case 'wave':
        if (ev.ok) { toast('👋 ' + (ev.npc || 'Ein NPC') + ' kommt und probiert das Gerät aus …', 'good'); Voice.say('Ich komme schon!', { pitch: 0.85 }); }
        else { toast('👋 Kein NPC in der Nähe, der dich sieht.', 'bad'); Sfx.play('error'); }
        break;
      case 'emoji': if (ev.id !== S.myId) Sfx.play('plopp'); break;
      case 'joined':
        Sfx.play('join');
        Voice.say('Ein Mitspieler ist beigetreten!', { prio: 1 });
        toast('🎉 ' + (ev.name || 'Jemand') + ' ist beigetreten!', 'good');
        vibrate([40, 30, 40]);
        break;
      case 'left': toast('👋 ' + (ev.name || 'Jemand') + ' hat den Raum verlassen.', 'info'); break;
      case 'toast': toast(ev.msg, ev.kind || 'info'); break;
      case 'say': Voice.say(ev.text, { prio: 1 }); break;
      case 'win': {
        let txt;
        if (ev.team !== undefined && ev.team !== null && ev.team >= 0 && !ev.name) txt = teamInfo(ev.team).name + ' gewinnt!';
        else txt = ev.id === S.myId ? 'Du hast gewonnen! Streiche Alarm!' : (ev.name || 'Jemand') + ' gewinnt!';
        Voice.say(txt, { prio: 2 });
        Sfx.play('win');
        break;
      }
      case 'start':
        Voice.say('Los geht\'s! Viel Spaß beim Streiche spielen!', { prio: 1 });
        Sfx.play('go');
        break;
      case 'countdown': showCountdown(ev.n); break;
      default: break;
    }
  }
  function showCountdown(n) {
    const e = $('#countdown');
    e.textContent = n > 0 ? String(n) : 'LOS!';
    show(e, true);
    e.classList.remove('anim'); void e.offsetWidth; e.classList.add('anim');
    Sfx.play(n > 0 ? 'tick' : 'go');
    if (n <= 0) Voice.say('Los!', { prio: 2 });
    clearTimeout(showCountdown.t);
    showCountdown.t = setTimeout(() => show(e, false), 950);
  }

  /* ------------------------------------------------------------------
     20. Ergebnis
     ------------------------------------------------------------------ */
  let resTimer = 0;
  function onResults(r) {
    if (!r) return;
    S.resultsOpen = true;
    closeWheel();
    updateControlsVisibility();
    const ranking = r.ranking || [];
    let title = '⏱ Zeit abgelaufen!';
    if (r.winner && r.winner.team !== undefined && r.winner.team !== null && r.winner.id === undefined) title = '🏆 ' + teamInfo(r.winner.team).name + ' gewinnt!';
    else if (r.winner && r.winner.id) title = r.winner.id === S.myId ? '🏆 Du hast gewonnen!' : '🏆 ' + (r.winner.name || '???') + ' gewinnt!';
    $('#resTitle').textContent = title;
    const reasons = { exit: 'Durch den Ausgang entkommen – Feierabend!', time: 'Die Zeit ist um!', schaetze: 'Alle geheimen Items gesichert!' };
    const mode = (C().modes || {})[r.mode] || {};
    $('#resSub').textContent = (mode.icon || '') + ' ' + (mode.name || '') + ' · ' + (reasons[r.reason] || '');
    // Podest
    const pod = $('#resPodium');
    pod.innerHTML = '';
    const order = [1, 0, 2];
    order.forEach((idx) => {
      const p = ranking[idx];
      if (!p) return;
      const cv = h('canvas', {});
      pod.appendChild(h('div', { class: 'pod p' + (idx + 1) }, cv, h('b', null, p.name), h('div', { class: 'pod-block' }, String(idx + 1))));
      drawAvatarFit(cv, p.avatar, 86, 94, { pose: idx === 0 ? 'cheer' : 'idle', facing: 1 });
    });
    // Liste
    const list = $('#resList');
    list.innerHTML = '';
    ranking.forEach((p, i) => {
      const val = r.mode === 'checkliste' ? p.prog + '/4 ✅ · ' + p.score + ' P' : r.mode === 'schatzsuche' ? p.prog + '/3 💎 · ' + p.score + ' P' : p.score + ' P';
      const dot = r.mode === 'teams' && p.team >= 0 ? '<span class="sb-dot" style="background:' + teamInfo(p.team).color + '"></span> ' : '';
      list.appendChild(h('div', { class: 'res-row' + (p.id === S.myId ? ' me' : ''), html:
        '<span class="rr-pos">' + (i + 1) + '.</span><span class="rr-name">' + dot + (p.bot ? '🤖 ' : '') + esc(p.name) + '</span><span>' + esc(val) + '</span>' }));
    });
    if (r.teamScores) {
      list.appendChild(h('div', { class: 'res-row', html: '<span class="rr-name">Teams</span><span style="color:' + teamInfo(0).color + '">' + r.teamScores[0] + '</span> : <span style="color:' + teamInfo(1).color + '">' + r.teamScores[1] + '</span>' }));
    }
    // Belohnungen
    const rw = $('#resRewards');
    rw.innerHTML = '';
    if (r.you) {
      if (r.you.levelUp) rw.appendChild(h('div', { class: 'reward lvl' }, '🎉 Level-Up! Jetzt Level ' + r.you.level));
      rw.appendChild(h('div', { class: 'reward xp' }, '+' + (r.you.xp || 0) + ' XP'));
      rw.appendChild(h('div', { class: 'reward coins' }, '+' + (r.you.coins || 0) + ' 🪙'));
      (r.you.dailyDone || []).forEach((d) => rw.appendChild(h('div', { class: 'reward daily' }, '📅 Geschafft: ' + d + ' (+60 🪙)')));
      if (r.you.levelUp) setTimeout(() => { Voice.say('Level aufgestiegen!', { prio: 1 }); Sfx.play('fanfare'); }, 1500);
    }
    const host = isHost();
    show('#resAgain', host);
    let left = 12;
    const upd = () => { $('#resAuto').textContent = host ? 'Automatisch zurück in die Lobby in ' + left + ' s …' : 'Gleich geht’s zurück in die Lobby (' + left + ' s) …'; };
    upd();
    clearInterval(resTimer);
    resTimer = setInterval(() => { left = Math.max(0, left - 1); upd(); if (!left) clearInterval(resTimer); }, 1000);
    show('#scr-results', true);
    if (r.winner && r.winner.id === S.myId) safe(() => Render.burst('confetti', mePos().x, mePos().y, { big: true }));
  }
  function closeResults() {
    S.resultsOpen = false;
    clearInterval(resTimer);
    show('#scr-results', false);
    updateControlsVisibility();
  }

  /* ------------------------------------------------------------------
     21. Sheets: Editor, Shop, Bestenliste, Herausforderungen, Einstellungen, App, Hilfe
     ------------------------------------------------------------------ */
  const SHEET_TITLES = { editor: '🎨 Charakter', shop: '🛒 Prank-Shop', board: '🏆 Bestenliste', daily: '📅 Tägliche Herausforderungen', settings: '⚙️ Einstellungen', install: '📲 Als App installieren', help: '❓ So geht’s' };
  const sheetState = { tab: null, draft: null, raf: 0, board: null, boardLoading: false };
  function openSheet(kind) {
    if (!S.profile && (kind === 'editor' || kind === 'shop' || kind === 'daily')) { toast('Bitte zuerst anmelden.', 'bad'); return; }
    S.sheet = kind;
    sheetState.tab = null;
    if (kind === 'editor') sheetState.draft = Object.assign({}, myAvatar());
    if (kind === 'board') { sheetState.board = null; loadBoard(); }
    $('#sheetTitle').textContent = SHEET_TITLES[kind] || '';
    $('#sheetCoins').textContent = '🪙 ' + ((S.profile && S.profile.coins) || 0);
    show('#sheetCoins', kind === 'editor' || kind === 'shop');
    show('#sheet', true);
    closeWheel();
    show('#hudMenu', false);
    renderSheet();
    Sfx.play('klick');
  }
  function closeSheet() {
    S.sheet = null;
    cancelAnimationFrame(sheetState.raf);
    show('#sheet', false);
    if (S.view === 'home') renderHome();
  }
  function renderSheet() {
    const body = $('#sheetBody');
    cancelAnimationFrame(sheetState.raf);
    const scroll = body.scrollTop;
    body.innerHTML = '';
    switch (S.sheet) {
      case 'editor': renderEditor(body); break;
      case 'shop': renderShop(body); break;
      case 'board': renderBoard(body); break;
      case 'daily': renderDaily(body); break;
      case 'settings': renderSettings(body); break;
      case 'install': renderInstall(body); break;
      case 'help': renderHelp(body); break;
      default: break;
    }
    body.scrollTop = scroll;
  }
  function tabs(list, cur, onPick) {
    const box = h('div', { class: 'tabs' });
    list.forEach((t) => box.appendChild(h('button', { class: 'tab' + (t.id === cur ? ' sel' : ''), type: 'button', onclick: () => { Sfx.play('klick'); onPick(t.id); } }, t.label)));
    return box;
  }
  async function buy(id) {
    const e = shopEntry(id);
    if (!e) return false;
    const p = S.profile || {};
    if ((p.coins || 0) < e.price) {
      Sfx.play('error');
      toast('🪙 Nicht genug Münzen – dir fehlen noch ' + (e.price - (p.coins || 0)) + '. Spiel ein paar Runden!', 'bad', 3000);
      return false;
    }
    if (e.minLevel && (p.level || 1) < e.minLevel) { Sfx.play('error'); toast('⭐ Erst ab Level ' + e.minLevel + '!', 'bad'); return false; }
    const ok = await confirmBox('„' + e.name + '“ für ' + e.price + ' 🪙 kaufen?', 'Kaufen 🪙', 'Lieber nicht');
    if (!ok) return false;
    const res = await emitAck('shop:buy', { id });
    if (!res.ok) { Sfx.play('error'); toast(res.msg || 'Kauf fehlgeschlagen.', 'bad'); return false; }
    Sfx.play('coins');
    setTimeout(() => Sfx.play('fanfare'), 150);
    toast('🎉 „' + e.name + '“ freigeschaltet!', 'good');
    setProfile(res.profile);
    return true;
  }

  // ---- Charakter-Editor
  let saveAvatarTimer = 0;
  function saveDraftSoon() {
    clearTimeout(saveAvatarTimer);
    saveAvatarTimer = setTimeout(async () => {
      const res = await emitAck('profile:update', { avatar: sheetState.draft });
      if (res.ok) { S.profile = res.profile; store('sl_profile', res.profile); if (S.view === 'home') renderHome(); }
      else failToast(res);
    }, 450);
  }
  function renderEditor(body) {
    const av = C().avatar || {};
    const draft = sheetState.draft || (sheetState.draft = Object.assign({}, myAvatar()));
    const tabList = [
      { id: 'skin', label: '🧑 Haut' }, { id: 'hair', label: '💇 Frisur' }, { id: 'hairColor', label: '🎨 Haarfarbe' },
      { id: 'face', label: '😀 Gesicht' }, { id: 'outfit', label: '👔 Outfit' }, { id: 'outfitColor', label: '🌈 Farbe' }, { id: 'acc', label: '🎩 Extras' }
    ];
    const tab = sheetState.tab || 'hair';
    const preview = h('canvas', {});
    const layout = h('div', { class: 'editor-layout' },
      h('div', { class: 'editor-preview' }, preview,
        h('b', null, (S.profile && S.profile.name) || ''),
        h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => {
          sheetState.draft = Object.assign(randomFreeAvatar(), {});
          Sfx.play('boing'); saveDraftSoon(); renderSheet();
        } }, '🎲 Zufall (gratis Teile)')),
      h('div', null, tabs(tabList, tab, (id) => { sheetState.tab = id; renderSheet(); }), editorOptions(tab, draft, av)));
    body.appendChild(layout);
    body.appendChild(h('p', { class: 'hint small center' }, 'Änderungen werden automatisch gespeichert. 🔒-Teile gibt’s für Chaos-Münzen.'));
    const start = now();
    const loop = () => {
      const t = (now() - start) / 1000;
      const pose = (t % 6) > 5 ? 'wave' : 'idle';
      drawAvatarFit(preview, sheetState.draft, 180, 200, { pose, t, pad: 0.08 });
      sheetState.raf = requestAnimationFrame(loop);
    };
    loop();
  }
  const HAT_ACCS = ['basecap', 'bauhelm', 'zylinder', 'krone'];
  function editorOptions(tab, draft, av) {
    const wrap = h('div', null);
    if (tab === 'skin' || tab === 'hairColor' || tab === 'outfitColor') {
      const colors = tab === 'skin' ? (av.skins || []) : tab === 'hairColor' ? (av.hairColors || []) : (av.outfitColors || []);
      const box = h('div', { class: 'swatches' });
      colors.forEach((c, i) => box.appendChild(h('button', {
        class: 'swatch' + (draft[tab] === i ? ' sel' : ''), type: 'button', style: 'background:' + c, title: 'Farbe ' + (i + 1),
        onclick: () => { draft[tab] = i; Sfx.play('plopp'); saveDraftSoon(); renderSheet(); }
      })));
      wrap.appendChild(box);
      return wrap;
    }
    const grid = h('div', { class: 'opt-grid' });
    partList(tab).forEach((part) => {
      const sid = tab + ':' + part.id;
      const entry = shopEntry(sid);
      const have = owns(sid);
      const cv = h('canvas', {});
      const btn = h('button', {
        class: 'opt' + (draft[tab] === part.id ? ' sel' : '') + (have ? '' : ' locked'), type: 'button',
        onclick: async () => {
          if (!have) { const ok = await buy(sid); if (!ok) return; }
          draft[tab] = part.id;
          Sfx.play('plopp');
          saveDraftSoon();
          renderSheet();
        }
      }, cv, part.name, (!have && entry) ? h('span', { class: 'price' }, '🔒 ' + entry.price) : null);
      grid.appendChild(btn);
      const test = Object.assign({}, draft);
      test[tab] = part.id;
      if (tab === 'hair' && HAT_ACCS.indexOf(test.acc) >= 0) test.acc = 'keins'; // Frisur nicht unter Hut verstecken
      drawAvatarFit(cv, test, 64, 64, { crop: (tab === 'outfit') ? null : 'bust', pad: 0.03 });
    });
    wrap.appendChild(grid);
    return wrap;
  }

  // ---- Shop
  function renderShop(body) {
    const p = S.profile || {};
    const tabList = [
      { id: 'rad', label: '🎡 Fallen-Rad' }, { id: 'perk', label: '🧠 Perks' }, { id: 'gebaeude', label: '🏢 Gebäude' },
      { id: 'hair', label: '💇 Frisuren' }, { id: 'face', label: '😀 Gesichter' }, { id: 'outfit', label: '👔 Outfits' }, { id: 'acc', label: '🎩 Extras' }, { id: 'emote', label: '😂 Emotes' }
    ];
    const tab = sheetState.tab || 'rad';
    body.appendChild(tabs(tabList, tab, (id) => { sheetState.tab = id; renderSheet(); }));
    const shop = C().shop || {};
    const list = h('div', { class: 'shop-list' });
    if (tab === 'rad') {
      const slots = p.slots || 3;
      body.appendChild(h('p', { class: 'hint' }, '🎡 Dein Fallen-Rad: ' + slots + ' von 7 Slots frei' + (p.master ? ' + 9er-Meisterrad ✔' : '') + '. Slots 1–3 = schnelle Basis-Streiche (1,5 s), 4–7 = Profi-Streiche (2,5 s), 8–9 = Meister-Streiche (3,5 s).'));
      ['slot4', 'slot5', 'slot6', 'slot7', 'master'].forEach((id) => {
        const e = shop[id];
        if (!e) return;
        const have = owns(id);
        let blocked = '';
        if (!have) {
          const m = /^slot(\d)$/.exec(id);
          if (m && slots < Number(m[1]) - 1) blocked = 'Erst Slot ' + (Number(m[1]) - 1);
          if (id === 'master' && slots < 7) blocked = 'Erst Slot 7';
          if (e.minLevel && (p.level || 1) < e.minLevel) blocked = blocked || 'Ab Level ' + e.minLevel;
        }
        list.appendChild(shopRow(id, e, have, blocked));
      });
    } else if (tab === 'perk') {
      body.appendChild(h('p', { class: 'hint' }, 'Perks musst du ausrüsten – immer nur einer ist aktiv.'));
      const perks = C().perks || {};
      Object.keys(perks).forEach((pid) => {
        const id = 'perk:' + pid;
        const e = shop[id] || { name: perks[pid].name, price: 0, icon: perks[pid].icon, desc: perks[pid].desc };
        const have = owns(id);
        const equipped = p.perk === pid;
        const row = shopRow(id, Object.assign({}, e, { icon: perks[pid].icon || e.icon, desc: perks[pid].desc || e.desc, name: perks[pid].name || e.name }), have, '');
        if (have) {
          const btn = row.querySelector('.btn, .owned-tag');
          const nb = h('button', {
            class: 'btn btn-small ' + (equipped ? 'btn-primary' : 'btn-light'), type: 'button',
            onclick: async () => {
              const res = await emitAck('profile:update', { perk: equipped ? null : pid });
              if (!res.ok) { failToast(res); return; }
              Sfx.play('klick');
              toast(equipped ? 'Perk abgelegt.' : (perks[pid].icon || '') + ' ' + perks[pid].name + ' ausgerüstet!', 'good');
              setProfile(res.profile);
            }
          }, equipped ? '✔ Aktiv' : 'Ausrüsten');
          if (btn) btn.replaceWith(nb); else row.appendChild(nb);
        }
        list.appendChild(row);
      });
    } else if (tab === 'gebaeude') {
      const blds = C().buildings || {};
      Object.keys(blds).filter((bid) => isSelectable(bid, blds[bid])).forEach((bid) => {
        const b = blds[bid];
        const id = 'bld:' + bid;
        const e = shop[id] || { name: b.name, price: b.price || 0, icon: b.icon, desc: b.desc };
        list.appendChild(shopRow(id, Object.assign({}, e, { icon: b.icon || e.icon, desc: b.desc || e.desc, name: b.name || e.name }), !b.price || owns(id), ''));
      });
    } else if (tab === 'emote') {
      (C().emotes || []).forEach((em, i) => {
        const id = 'emote:' + em;
        const e = shop[id] || { name: 'Emote ' + em, price: 0, icon: em };
        list.appendChild(shopRow(id, Object.assign({}, e, { icon: em, desc: i < 4 ? 'Gratis dabei' : 'Im Spiel antippen, damit alle es sehen' }), i < 4 || owns(id), ''));
      });
    } else {
      partList(tab).forEach((part) => {
        const id = tab + ':' + part.id;
        const e = shop[id];
        const have = owns(id);
        const row = shopRow(id, e || { name: part.name, price: 0, desc: 'Gratis' }, have, '', true);
        const cv = row.querySelector('canvas');
        if (cv) { const test = Object.assign({}, myAvatar()); test[tab] = part.id; if (tab === 'hair' && HAT_ACCS.indexOf(test.acc) >= 0) test.acc = 'keins'; drawAvatarFit(cv, test, 54, 54, { crop: tab === 'outfit' ? null : 'bust', pad: 0.02 }); }
        list.appendChild(row);
      });
    }
    body.appendChild(list);
  }
  function shopRow(id, e, have, blocked, withCanvas) {
    const btn = have ? h('span', { class: 'owned-tag' }, '✔ Gehört dir')
      : blocked ? h('button', { class: 'btn btn-small btn-light', type: 'button', disabled: true }, '🔒 ' + blocked)
        : h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: async () => { if (await buy(id)) renderSheet(); } }, '🪙 ' + (e.price || 0));
    return h('div', { class: 'shop-item' + (have ? ' owned' : '') },
      withCanvas ? h('canvas', {}) : h('span', { class: 'si-ico' }, e.icon || '🎁'),
      h('div', { class: 'si-text' }, h('b', null, e.name || id), h('small', null, e.desc || (e.minLevel ? 'Ab Level ' + e.minLevel : ''))),
      btn);
  }

  // ---- Bestenliste
  async function loadBoard() {
    sheetState.boardLoading = true;
    const res = await emitAck('leaderboard:get', {});
    sheetState.boardLoading = false;
    sheetState.board = res.ok ? (res.list || []) : [];
    if (S.sheet === 'board') renderSheet();
  }
  function renderBoard(body) {
    body.appendChild(h('p', { class: 'hint' }, '🏆 Die besten Prank-Meister aller Zeiten – Punkte aus allen Runden.'));
    if (!sheetState.board) { body.appendChild(h('div', { class: 'room-empty' }, '⏳ Lade Bestenliste …')); return; }
    if (!sheetState.board.length) { body.appendChild(h('div', { class: 'room-empty' }, 'Noch keine Einträge – spiel die erste Runde!')); return; }
    const list = h('div', { class: 'board-list' });
    const myName = S.profile ? S.profile.name.toLowerCase() : '';
    sheetState.board.forEach((r, i) => {
      const cv = h('canvas', {});
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
      list.appendChild(h('div', { class: 'board-row' + (i === 0 ? ' top1' : '') + (r.name && r.name.toLowerCase() === myName ? ' me' : '') },
        h('span', { class: 'br-pos' }, medal), cv,
        h('span', { class: 'br-name' }, r.name, h('small', { style: 'display:block;font-weight:400;color:#4a3a8a' }, 'Level ' + (r.level || 1) + ' · ' + (r.wins || 0) + ' Siege')),
        h('span', { class: 'br-pts' }, (r.points || 0) + ' P')));
      drawAvatarFit(cv, r.avatar, 44, 44, { crop: 'bust', pad: 0.02 });
    });
    body.appendChild(list);
  }

  // ---- Tägliche Herausforderungen
  function renderDaily(body) {
    const d = (S.profile && S.profile.daily) || { list: [] };
    body.appendChild(h('p', { class: 'hint' }, '📅 Jeden Tag 3 neue Büro-Herausforderungen. Pro geschaffter Aufgabe: +60 🪙 und +80 XP. Neue gibt’s ab Mitternacht.'));
    if (!d.list || !d.list.length) { body.appendChild(h('div', { class: 'room-empty' }, 'Spiel eine Runde, dann geht’s los!')); return; }
    d.list.forEach((x) => {
      const pct = clamp((x.prog || 0) / (x.goal || 1) * 100, 0, 100);
      body.appendChild(h('div', { class: 'daily-item' + (x.done ? ' done' : '') },
        h('b', null, (x.done ? '✅ ' : '🎯 ') + x.text),
        h('div', { class: 'daily-bar' }, h('i', { style: 'width:' + pct + '%' })),
        h('small', null, Math.min(x.prog || 0, x.goal || 1) + ' / ' + (x.goal || 1) + (x.done ? ' – geschafft!' : ''))));
    });
  }

  // ---- Einstellungen
  let saveSettingsTimer = 0;
  function saveSettingsSoon() { clearTimeout(saveSettingsTimer); saveSettingsTimer = setTimeout(() => store('sl_settings', S.settings), 300); }
  function applySettings() {
    Sfx.set(S.settings.sound);
    Voice.set(S.settings.voice);
    updateControlsVisibility();
    resizeMinimap();
    saveSettingsSoon();
  }
  function settingSwitch(key, label, sub) {
    const inp = h('input', { type: 'checkbox', checked: !!S.settings[key], onchange: (e) => { S.settings[key] = e.target.checked; applySettings(); Sfx.play('klick'); } });
    return h('div', { class: 'set-row' }, h('span', null, label, sub ? h('small', null, sub) : null), h('label', { class: 'switch' }, inp, h('i', null)));
  }
  function renderSettings(body) {
    const ctrl = h('div', { class: 'seg' });
    [['joystick', '🕹️ Joystick'], ['tap', '👆 Tap-to-Walk']].forEach((o) => ctrl.appendChild(h('button', {
      type: 'button', class: S.settings.controls === o[0] ? 'sel' : '',
      onclick: () => { S.settings.controls = o[0]; applySettings(); Sfx.play('klick'); renderSheet(); }
    }, o[1])));
    body.appendChild(h('div', { class: 'set-row set-col' }, h('span', null, '📱 Handy-Steuerung', h('small', null, 'Joystick links + Buttons rechts – oder einfach dorthin tippen, wo du hinwillst')), ctrl));
    body.appendChild(settingSwitch('sound', '🔊 Sound-Effekte', 'Boing, Schlürfen, Zischen …'));
    body.appendChild(settingSwitch('voice', '🗣️ Sprachausgabe', Voice.available ? 'Deutsche Ausrufe wie „Autsch, heißer Kaffee!“' : 'Dein Browser unterstützt keine Sprachausgabe'));
    body.appendChild(h('div', { class: 'set-row' }, h('span', null, ''), h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { unlockAudio(); Sfx.play('boing'); Voice.say('Autsch, heißer Kaffee!', { prio: 2 }); } }, '▶ Ton testen')));
    body.appendChild(settingSwitch('vibrate', '📳 Vibration', 'Kurzes Rütteln, wenn dich eine Falle erwischt'));
    body.appendChild(settingSwitch('minimap', '🗺️ Minikarte', 'Zeigt Ziele für Bedürfnisse & Aufgaben'));
    const zoom = h('input', { type: 'range', min: '0.6', max: '1.8', step: '0.05', value: String(S.settings.zoom || 1),
      oninput: (e) => { S.settings.zoom = Number(e.target.value); saveSettingsSoon(); } });
    body.appendChild(h('div', { class: 'set-row' }, h('span', null, '🔍 Zoom', h('small', null, 'Am PC auch mit dem Mausrad')), zoom));
    body.appendChild(h('div', { class: 'set-row' }, h('span', null, '⛶ Vollbild'), h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: toggleFullscreen }, 'Umschalten')));
    if (S.profile) {
      body.appendChild(h('div', { class: 'set-row' }, h('span', null, '🪪 Spieler-Ausweis', h('small', null, S.profile.name + ' · Code ' + ((S.account && S.account.code) || ''))),
        h('button', { class: 'btn btn-small btn-danger', type: 'button', onclick: () => { closeSheet(); logout(); } }, 'Abmelden')));
    }
    body.appendChild(h('p', { class: 'hint small center' }, 'Streiche Alarm · Version 1.0'));
  }

  // ---- Installation
  function renderInstall(body) {
    if (isStandalone()) {
      body.appendChild(h('p', { class: 'hint' }, '✅ Streiche Alarm läuft bereits als App. Viel Spaß!'));
      return;
    }
    if (S.installPrompt) {
      body.appendChild(h('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: async () => {
        const pr = S.installPrompt; S.installPrompt = null;
        try { pr.prompt(); const ch = await pr.userChoice; if (ch && ch.outcome === 'accepted') toast('📲 Wird installiert – schau auf deinen Home-Bildschirm!', 'good'); } catch (e) { /* egal */ }
        renderSheet();
      } }, '📲 Jetzt installieren'));
    }
    body.appendChild(h('div', { html:
      '<h3 class="sec-title">🍏 iPhone / iPad (Safari)</h3><ol class="help-list"><li>Unten auf <b>Teilen</b> tippen (Quadrat mit Pfeil ⬆️).</li><li><b>„Zum Home-Bildschirm“</b> wählen.</li><li><b>Hinzufügen</b> – fertig! Startet dann im Vollbild.</li></ol>' +
      '<h3 class="sec-title">🤖 Android (Chrome)</h3><ol class="help-list"><li>Oben rechts auf <b>⋮</b> tippen.</li><li><b>„App installieren“</b> bzw. „Zum Startbildschirm hinzufügen“.</li></ol>' +
      '<h3 class="sec-title">💻 PC (Chrome / Edge)</h3><ol class="help-list"><li>In der Adresszeile auf das <b>Installieren-Symbol</b> klicken.</li></ol>' }));
  }

  // ---- Hilfe
  function renderHelp(body) {
    body.appendChild(h('div', { html:
      '<h3 class="sec-title">🎯 Worum geht’s?</h3><p>Stell deinen Freunden fiese (aber harmlose) Slapstick-Fallen an Kaffeemaschine, WC, Snackautomat & Co. – und tapp selbst nicht hinein! Auch deine eigenen Fallen sind unsichtbar.</p>' +
      '<h3 class="sec-title">☕ Bedürfnisse</h3><p>Über deinem Kopf ploppt ☕, 🚻 oder 🍫 auf. Erledigst du es am passenden Gerät, gibt’s 5 s Turbo. Wartest du zu lang, wirst du 30 % langsamer. Genau dort lauern die besten Fallen!</p>' +
      '<h3 class="sec-title">🪤 Fallen</h3><ul class="help-list"><li>Stell dich zu einem Gerät und öffne das <b>Fallen-Rad</b>.</li><li>Lässt dich ein NPC oder Gegner beim Bauen erwischen, löst die Falle an <b>dir</b> aus!</li><li>Bereits scharfe Geräte erwischen dich, wenn du sie anfasst.</li><li><b>Winken</b> lockt NPCs, die verdächtige Geräte „vortesten“.</li><li>Verstecke dich in Spinden & Co. oder <b>tarne</b> dich als NPC.</li></ul>' +
      '<h3 class="sec-title">⌨️ PC-Steuerung</h3><ul class="help-list"><li><span class="kbd">W A S D</span> / Pfeile: laufen · Klick: hinlaufen</li><li><span class="kbd">E</span>: benutzen · <span class="kbd">F</span>: Fallen-Rad · <span class="kbd">1</span>–<span class="kbd">9</span> im Rad: Streich wählen</li><li><span class="kbd">Leertaste</span>: verstecken · <span class="kbd">V</span>: verkleiden · <span class="kbd">R</span>: winken</li><li><span class="kbd">1</span>–<span class="kbd">4</span>: Emojis · <span class="kbd">M</span>: große Karte · Mausrad: Zoom</li></ul>' +
      '<h3 class="sec-title">📱 Handy</h3><p>Joystick links (dort aufsetzen, wo dein Daumen ist), Buttons rechts. Lieber tippen statt Joystick? In den Einstellungen auf <b>Tap-to-Walk</b> umschalten.</p>' }));
  }

  /* ------------------------------------------------------------------
     22. Vollbild, PWA, Service Worker
     ------------------------------------------------------------------ */
  function toggleFullscreen() {
    const d = document, el = d.documentElement;
    const fsEl = d.fullscreenElement || d.webkitFullscreenElement;
    if (fsEl) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        const pr = req.call(el, { navigationUI: 'hide' });
        if (pr && pr.catch) pr.catch(() => fullscreenHint());
      } catch (e) { fullscreenHint(); }
    } else fullscreenHint();
  }
  function fullscreenHint() {
    infoBox(isIOS
      ? 'Auf dem iPhone gibt es kein Browser-Vollbild. Tipp: Teilen ⬆️ → „Zum Home-Bildschirm“ – dann startet Streiche Alarm als App im Vollbild!'
      : 'Vollbild wird hier nicht unterstützt. Installiere Streiche Alarm als App (Menü → „App installieren“).');
  }
  document.addEventListener('fullscreenchange', () => setTimeout(() => safe(() => Render.resize()), 120));
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; });
  window.addEventListener('appinstalled', () => toast('📲 Streiche Alarm ist jetzt als App installiert!', 'good'));
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* ohne SW geht's auch */ }); });
  }

  /* ------------------------------------------------------------------
     23. UI-Verdrahtung
     ------------------------------------------------------------------ */
  $('#setupCode').addEventListener('input', checkSetupCode);
  $('#setupDice').addEventListener('click', () => { $('#setupCode').value = suggestCode(); checkSetupCode(); Sfx.play('boing'); });
  $('#setupGo').addEventListener('click', doRegister);
  $('#setupToLoad').addEventListener('click', () => { showLoadForm(true); $('#loadErr').textContent = ''; });
  $('#loadBack').addEventListener('click', () => showLoadForm(false));
  $('#loadGo').addEventListener('click', doLoad);
  $('#loadCode').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });

  $('#btnCreate').addEventListener('click', createRoom);
  $('#btnJoin').addEventListener('click', () => joinRoom($('#joinCode').value));
  $('#joinCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); $('#homeErr').textContent = ''; });
  $('#ausweisCopy').addEventListener('click', () => {
    const p = S.profile || {};
    copyText('Streiche Alarm – Name: ' + (p.name || '') + ' | Code: ' + ((S.account && S.account.code) || '')).then((ok) => toast(ok ? '📋 Name & Code kopiert!' : 'Kopieren ging nicht – bitte abschreiben.', ok ? 'good' : 'bad'));
  });
  $('#homeProfileChip').addEventListener('click', () => openSheet('editor'));
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open)));
  $('#btnFullscreenHome').addEventListener('click', toggleFullscreen);
  $('#btnLogout').addEventListener('click', logout);
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

  $('#lobbyToggle').addEventListener('click', () => { S.lobbyCollapsed = !S.lobbyCollapsed; applyLobbyCollapse(); Sfx.play('whoosh'); });
  $('#lobbyLeave').addEventListener('click', async () => { if (await confirmBox('Raum wirklich verlassen?', 'Verlassen', 'Bleiben')) leaveRoom(); });
  $('#lobbyCopyLink').addEventListener('click', () => {
    if (!S.room) return;
    copyText(location.origin + '/?room=' + S.room.code).then((ok) => toast(ok ? '🔗 Einladungslink kopiert!' : 'Kopieren ging nicht.', ok ? 'good' : 'bad'));
  });
  $('#lobbyShare').addEventListener('click', () => {
    if (!S.room) return;
    const url = location.origin + '/?room=' + S.room.code;
    if (navigator.share) navigator.share({ title: 'Streiche Alarm', text: 'Komm in meinen Streiche Alarm-Raum ' + S.room.code + '!', url }).catch(() => {});
    else copyText(url).then(() => toast('🔗 Link kopiert – einfach weiterschicken!', 'good'));
  });
  $('#btnWhatsApp').addEventListener('click', () => Sfx.play('klick'));
  $('#botAdd').addEventListener('click', () => { Sfx.play('klick'); emitAck('room:bot', { action: 'add' }).then(failToast); });
  $('#botRemove').addEventListener('click', () => { Sfx.play('klick'); emitAck('room:bot', { action: 'remove' }).then(failToast); });
  $$('#durationSeg button').forEach((b) => b.addEventListener('click', () => setRoomSetting({ duration: Number(b.dataset.val) })));
  $$('#trapRuleSeg button').forEach((b) => b.addEventListener('click', () => setRoomSetting({ trapRule: b.dataset.val })));
  $('#partyToggle').addEventListener('change', (e) => setRoomSetting({ party: e.target.checked }));
  $('#btnStart').addEventListener('click', async () => {
    if (!isHost()) return;
    $('#btnStart').disabled = true;
    const res = await emitAck('room:start', {});
    $('#btnStart').disabled = false;
    if (!res.ok) { toast(res.msg || 'Start fehlgeschlagen.', 'bad'); Sfx.play('error'); }
  });

  $('#hudMenuBtn').addEventListener('click', () => { const m = $('#hudMenu'); show(m, m.classList.contains('hidden')); });
  $('#hudFullscreen').addEventListener('click', () => { show('#hudMenu', false); toggleFullscreen(); });
  $('#hudSettings').addEventListener('click', () => openSheet('settings'));
  $('#hudHelp').addEventListener('click', () => openSheet('help'));
  $('#hudLeave').addEventListener('click', async () => {
    show('#hudMenu', false);
    if (await confirmBox('Runde verlassen? Eine KI übernimmt deine Figur.', 'Verlassen', 'Weiterspielen')) leaveRoom();
  });
  $('#buildCancel').addEventListener('click', () => act('cancel'));
  $('#specNext').addEventListener('click', cycleFollow);
  $('#resAgain').addEventListener('click', () => { emitAck('room:again', {}).then(failToast); });
  $('#resMenu').addEventListener('click', () => leaveRoom());

  function cycleFollow() {
    const ents = (S.lastSnap && S.lastSnap.e) || [];
    const ps = ents.filter((e) => e.k === 'p');
    if (!ps.length) return;
    const i = ps.findIndex((e) => e.id === S.followId);
    S.followId = ps[(i + 1) % ps.length].id;
    S.followManual = true;
    toast('👀 Du schaust jetzt ' + ((S.players[S.followId] || {}).name || '') + ' zu.', 'info', 1500);
  }

  // Größenänderungen
  function onResize() {
    safe(() => Render.resize());
    applyLobbyCollapse();
    mmLast = 0;
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
  if (sideLayoutMQ.addEventListener) sideLayoutMQ.addEventListener('change', onResize);

  // iOS: Pinch-Zoom verhindern (Doppeltipp-Zoom verhindert bereits touch-action: manipulation)
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => { if (e.target.closest && (e.target.closest('#controls') || e.target.id === 'world')) e.preventDefault(); });

  /* ------------------------------------------------------------------
     24. Hauptschleife
     ------------------------------------------------------------------ */
  let lastFrame = now();
  function updatePrediction(dt) {
    const me = S.me;
    if (!me || !S.pred) return;
    const blocked = (me.hidden !== null && me.hidden !== undefined) || me.st === 'stun';
    const inp = S.input;
    const mag = Math.hypot(inp.x, inp.y);
    const before = { x: S.pred.x, y: S.pred.y };
    if (!blocked && mag > 0.02 && !S.target) {
      const spd = me.spd || 3.2;
      moveCollide(S.pred, inp.x * spd * dt, inp.y * spd * dt);
      const ex = me.x - S.pred.x, ey = me.y - S.pred.y;
      const err = Math.hypot(ex, ey);
      if (err > 1.5) { S.pred.x = me.x; S.pred.y = me.y; }
      else if (err > 0.3) { const k = Math.min(1, dt * 2.5); S.pred.x += ex * k; S.pred.y += ey * k; }
      S.facing = Math.atan2(inp.y, inp.x);
      S.moving = true;
    } else {
      const k = Math.min(1, dt * (me.st === 'stun' ? 12 : 9));
      const ex = me.x - S.pred.x, ey = me.y - S.pred.y;
      if (Math.hypot(ex, ey) > 3) { S.pred.x = me.x; S.pred.y = me.y; }
      else { S.pred.x += ex * k; S.pred.y += ey * k; }
      const mvx = S.pred.x - before.x, mvy = S.pred.y - before.y;
      const sp = Math.hypot(mvx, mvy) / Math.max(dt, 0.001);
      S.moving = sp > 0.5;
      if (S.moving) S.facing = Math.atan2(mvy, mvx);
    }
  }
  /** Bildschirm-Versatz, damit die eigene Figur nicht hinter der Lobby verschwindet */
  function lobbyViewOffset() {
    if (S.view !== 'lobby') return { x: 0, y: 0 };
    const panel = $('#lobbyPanel');
    if (!panel) return { x: 0, y: 0 };
    const r = panel.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    if (sideLayoutMQ.matches) {
      const right = Math.max(0, Math.min(W * 0.6, r.right));
      return { x: right / 2, y: 0 };
    }
    const top = Math.max(H * 0.25, Math.min(H, r.top));
    return { x: 0, y: (top - H) / 2 };
  }
  function frame() {
    requestAnimationFrame(frame);
    const t = now();
    const dt = Math.min(0.05, (t - lastFrame) / 1000);
    lastFrame = t;
    if (!S.world || (S.view !== 'game' && S.view !== 'lobby')) return;
    S.input = currentInput();
    if (Math.hypot(S.input.x, S.input.y) > 0.02 && S.target) S.target = null;
    maybeSendInput(t);
    updatePrediction(dt);
    const ents = interpEntities(t);
    // Kamera
    let camTarget = null;
    if (S.pred && !S.spectator) camTarget = S.pred;
    else if (S.spectator) {
      const f = ents.find((e) => e.id === S.followId) || ents.find((e) => e.k === 'p');
      if (f) { camTarget = { x: f.x, y: f.y }; if (!S.followId) S.followId = f.id; }
      else if (S.world.map) camTarget = { x: S.world.map.w / 2, y: S.world.map.h / 2 };
    }
    if (camTarget) {
      const off = lobbyViewOffset();
      if (off.x || off.y) {
        const cv = $('#world');
        const cx = cv.clientWidth / 2, cy = cv.clientHeight / 2;
        const a = safe(() => Render.screenToWorld(cx, cy)), b = safe(() => Render.screenToWorld(cx + off.x, cy + off.y));
        if (a && b && isFinite(a.x) && isFinite(b.x)) camTarget = { x: camTarget.x - (b.x - a.x), y: camTarget.y - (b.y - a.y) };
      }
      if (!S.cam) S.cam = { x: camTarget.x, y: camTarget.y };
      const k = Math.min(1, dt * 7);
      S.cam.x += (camTarget.x - S.cam.x) * k;
      S.cam.y += (camTarget.y - S.cam.y) * k;
    }
    if (!S.cam && S.world.map) S.cam = { x: S.world.map.w / 2, y: S.world.map.h / 2 };
    // Schallwellen-Alter
    const steps = [];
    for (let i = S.steps.length - 1; i >= 0; i--) {
      const age = (t - S.steps[i].t) / 1000;
      if (age > 1.3) { S.steps.splice(i, 1); continue; }
      steps.push([S.steps[i].x, S.steps[i].y, age]);
    }
    if (S.target && t - S.target.t > 9000) S.target = null;
    const me = S.me;
    const view = {
      t: t / 1000,
      dt,
      cam: S.cam,
      zoom: S.settings.zoom || 1,
      meId: S.myId,
      me: S.spectator ? null : me,
      mePos: S.pred ? { x: S.pred.x, y: S.pred.y } : null,
      meFacing: S.facing,
      meMoving: S.moving,
      meAvatar: myAvatar(),
      ents,
      steps,
      pickups: (S.lastSnap && S.lastSnap.pk) || [],
      nearDev: me && me.near ? me.near.dev : null,
      nearHide: me && me.near ? me.near.hide : null,
      target: S.target ? { x: S.target.x, y: S.target.y } : null,
      radar: (me && me.radar) || [],
      myTraps: (me && me.myTraps) || [],
      fog: !S.spectator,
      practice: S.practice,
      mode: modeName()
    };
    safe(() => Render.frame(view));
    frameHud(t);
    drawMinimap(t);
  }

  /* ------------------------------------------------------------------
     25. Start
     ------------------------------------------------------------------ */
  (function boot() {
    safe(() => Render.init($('#world')));
    // Raum-Code aus dem Link (?room=XXXX)
    try {
      const rc = new URL(location.href).searchParams.get('room');
      if (rc) { S.pendingRoom = rc.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); $('#joinCode').value = S.pendingRoom; }
    } catch (e) { /* egal */ }
    if (!S.settings.controls) S.settings.controls = 'joystick';
    Sfx.set(S.settings.sound);
    Voice.set(S.settings.voice);
    updateControlsVisibility();
    applyLobbyCollapse();
    if (!S.account) {
      $('#setupCode').value = suggestCode();
      if (S.pendingRoom) $('#setupHint').textContent = 'Fast geschafft! Leg kurz deinen Ausweis an, dann geht’s direkt in Raum ' + S.pendingRoom + '.';
    }
    // Falls der Server nicht erreichbar ist, trotzdem nach kurzer Zeit etwas zeigen
    setTimeout(() => { if (S.view === 'loading') { hideLoading(); setView(S.account ? 'home' : 'setup'); } }, 6000);
    requestAnimationFrame(frame);
  })();
})();
