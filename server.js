'use strict';
/* =====================================================================
 *  STREICHE ALARM – Server
 *  Slapstick-Stealth-Multiplayer für 2 bis 6 Spieler (Node.js + Socket.io)
 *  - Lobby mit Raum-Codes, Übungsplatz, Bots
 *  - Zufalls-Gebäudegenerator (Büro, Krankenhaus, Villa, Baumarkt)
 *  - Serverautoritative Simulation mit 20 Hz, Sichtbarkeitsfilter (Fog of War)
 *  - Konten (Name + 4-stelliger Code), Shop, Tägliche Herausforderungen, Bestenliste
 * ===================================================================== */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TICK_RATE = 20;
const DT = 1 / TICK_RATE;

/* ---------------------------------------------------------------------
 *  Hilfsfunktionen
 * ------------------------------------------------------------------- */
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1)); // inkl. b
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function viennaDate() {
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna' }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}
function safeCb(cb) { return typeof cb === 'function' ? cb : () => {}; }

/* ---------------------------------------------------------------------
 *  KATALOG – einzige Quelle für Namen, Icons, Preise, Fallen
 * ------------------------------------------------------------------- */
const FX_TYPES = ['hot', 'yuck', 'splash', 'foam', 'shake', 'launch', 'bonk', 'wet', 'sticky', 'tangle', 'spin', 'slip', 'confetti', 'mummy', 'paint', 'soot', 'squash', 'toot'];

const DEVICE_TYPES = {
  kaffeeautomat:      { name: 'Kaffeevollautomat',     family: 'kaffee',   icon: '☕', color: '#6d4c41', h: 1.1 },
  snackautomat:       { name: 'Snackautomat',          family: 'snack',    icon: '🍫', color: '#e53935', h: 1.5 },
  wc:                 { name: 'WC',                    family: 'sanitaer', icon: '🚽', color: '#eceff1', h: 0.7 },
  waschbecken:        { name: 'Waschbecken',           family: 'sanitaer', icon: '🚰', color: '#b3e5fc', h: 0.8 },
  kopierer:           { name: 'Kopierer',              family: 'papier',   icon: '🖨️', color: '#90a4ae', h: 1.0 },
  aktenvernichter:    { name: 'Aktenvernichter',       family: 'papier',   icon: '🗂️', color: '#546e7a', h: 0.8 },
  buerostuhl:         { name: 'Bürostuhl',             family: 'sitz',     icon: '🪑', color: '#37474f', h: 0.9 },
  chefsessel:         { name: 'Chefsessel',            family: 'sitz',     icon: '💺', color: '#4e342e', h: 1.1 },
  beamer:             { name: 'Beamer',                family: 'technik',  icon: '📽️', color: '#cfd8dc', h: 0.6 },
  saugroboter:        { name: 'Saugroboter',           family: 'roboter',  icon: '🤖', color: '#212121', h: 0.3, mobile: true },
  aktenschrank:       { name: 'Aktenschrank',          family: 'moebel',   icon: '🗄️', color: '#78909c', h: 1.4 },
  verbandswagen:      { name: 'Verbandswagen',         family: 'medizin',  icon: '🩹', color: '#ffffff', h: 1.0 },
  krankenbett:        { name: 'Krankenbett',           family: 'sitz',     icon: '🛏️', color: '#e3f2fd', h: 0.8 },
  roentgen:           { name: 'Röntgengerät',          family: 'medizin',  icon: '🩻', color: '#b0bec5', h: 1.5 },
  desinfektion:       { name: 'Desinfektions-Spender', family: 'medizin',  icon: '🧴', color: '#4fc3f7', h: 1.2 },
  wartestuhl:         { name: 'Wartezimmer-Stuhl',     family: 'sitz',     icon: '🪑', color: '#26a69a', h: 0.8 },
  medikamentenschrank:{ name: 'Arzneischrank',         family: 'moebel',   icon: '💊', color: '#e0f2f1', h: 1.4 },
  nummernautomat:     { name: 'Wartenummer-Automat',   family: 'papier',   icon: '🎫', color: '#ffb300', h: 1.2 },
  heimkino:           { name: 'Heimkino',              family: 'technik',  icon: '🎬', color: '#263238', h: 1.2 },
  rollladen:          { name: 'Smart-Rollladen',       family: 'technik',  icon: '🪟', color: '#9e9e9e', h: 1.6 },
  whirlpool:          { name: 'Whirlpool',             family: 'technik',  icon: '🛁', color: '#4dd0e1', h: 0.6 },
  grill:              { name: 'Grill',                 family: 'technik',  icon: '🍖', color: '#424242', h: 1.0 },
  poolabdeckung:      { name: 'Pool-Abdeckung',        family: 'technik',  icon: '🏊', color: '#1e88e5', h: 0.4 },
  sofa:               { name: 'Designer-Sofa',         family: 'sitz',     icon: '🛋️', color: '#8e24aa', h: 0.8 },
  kuehlschrank:       { name: 'Smart-Kühlschrank',     family: 'moebel',   icon: '🧊', color: '#eceff1', h: 1.6 },
  kommode:            { name: 'Kommode',               family: 'moebel',   icon: '🧺', color: '#a1887f', h: 0.9 },
  farbmischer:        { name: 'Farbmisch-Station',     family: 'baumarkt', icon: '🎨', color: '#ff7043', h: 1.3 },
  gartenschlauch:     { name: 'Gartenschlauch',        family: 'baumarkt', icon: '💦', color: '#43a047', h: 0.6 },
  hochregal:          { name: 'Hochregal',             family: 'baumarkt', icon: '📦', color: '#ff8f00', h: 1.6 },
  kasse:              { name: 'Kasse',                 family: 'papier',   icon: '🧾', color: '#5c6bc0', h: 1.0 },
  paketautomat:       { name: 'Paket-Abholung',        family: 'baumarkt', icon: '📮', color: '#fdd835', h: 1.5 },
  musterkueche:       { name: 'Musterküche',           family: 'technik',  icon: '🍳', color: '#f5f5f5', h: 1.0 },
  werkbank:           { name: 'Werkzeug-Werkbank',     family: 'baumarkt', icon: '🔧', color: '#8d6e63', h: 0.9 }
};
for (const k in DEVICE_TYPES) if (!DEVICE_TYPES[k].mobile) DEVICE_TYPES[k].mobile = false;

// [id, Name, fx, item, Spruch, Icon] – Reihenfolge = Slot 1..7
const TRAP_DATA = {
  kaffee: ['Kaffee-Streiche', [
    ['k_heiss', 'Extra-heißer Schluck', 'hot', 'chili', 'Autsch, heißer Kaffee!', '🔥'],
    ['k_salz', 'Salz statt Zucker', 'yuck', 'chili', 'Bäh! Wer hat hier Salz reingetan?!', '🧂'],
    ['k_becher', 'Explodierender Pappbecher', 'splash', 'seife', 'Mein schönes Hemd!', '💥'],
    ['k_vulkan', 'Milchschaum-Vulkan', 'foam', 'seife', 'Hilfe, ein Milchschaum-Vulkan!', '🌋'],
    ['k_koffein', 'Koffein-Zitter-Schock', 'shake', 'fernbedienung', 'Ich bin sooo wach!', '⚡'],
    ['k_jet', 'Espresso-Jetstream', 'launch', 'fernbedienung', 'Wuaaah, Espresso-Turbo!', '🚀'],
    ['k_bohnen', 'Bohnen-Hagel', 'bonk', 'klebeband', 'Aua, Kaffeebohnen!', '🫘']
  ]],
  sanitaer: ['Sanitär-Streiche', [
    ['s_fontaene', 'Spülkasten-Wasserfontäne', 'wet', 'fernbedienung', 'Pfui, alles nass!', '⛲'],
    ['s_klobrille', 'Festgeklebte Klobrille', 'sticky', 'klebeband', 'Ich kleb fest!', '🍯'],
    ['s_schaum', 'Seifenspender-Schaumparty', 'foam', 'seife', 'Schaumparty ohne mich!', '🫧'],
    ['s_handtuch', 'Endlos-Handtuchrollen-Verhedderung', 'tangle', 'klebeband', 'Diese Handtuchrolle hört nie auf!', '🧻'],
    ['s_ente', 'Quietscheenten-Flut', 'bonk', 'seife', 'Quietsch! Überall Enten!', '🦆'],
    ['s_klopapier', 'Klopapier-Tornado', 'spin', 'klebeband', 'Ich bin eine Klopapier-Mumie!', '🌪️'],
    ['s_eiswasser', 'Eiskalter Wasserstrahl', 'wet', 'chili', 'Huuuh, ist das kalt!', '🧊']
  ]],
  snack: ['Snack-Streiche', [
    ['n_lawine', 'Schokoriegel-Lawine', 'slip', 'seife', 'Uiii, Schokoriegel-Rutschpartie!', '🍫'],
    ['n_chili', 'Chili-Chips', 'hot', 'chili', 'Scharf! Wasser! Sofort!', '🌶️'],
    ['n_popcorn', 'Popcorn-Explosion', 'confetti', 'fernbedienung', 'Plopp-plopp-plopp!', '🍿'],
    ['n_kaugummi', 'Kaugummi-Klebefalle', 'sticky', 'klebeband', 'Igitt, Kaugummi!', '🍬'],
    ['n_brause', 'Brausepulver-Fontäne', 'foam', 'seife', 'Das prickelt ja überall!', '🫧'],
    ['n_gummibaer', 'Gummibärchen-Regen', 'bonk', 'fernbedienung', 'Gummibärchen-Alarm!', '🐻'],
    ['n_cola', 'Geschüttelte Cola-Dose', 'splash', 'chili', 'Klebrige Cola-Dusche!', '🥤']
  ]],
  sitz: ['Sitz- & Bett-Streiche', [
    ['z_drehwurm', 'Schleudersitz-Drehwurm', 'spin', 'fernbedienung', 'Mir ist sooo schwindelig!', '🌀'],
    ['z_katapult', 'Höhenverstellungs-Katapult', 'launch', 'fernbedienung', 'Ich kann fliegen!', '🚀'],
    ['z_furzkissen', 'Furzkissen-Konzert', 'toot', 'klebeband', 'Das war ich nicht!', '🎺'],
    ['z_rollen', 'Wackel-Rollen', 'slip', 'seife', 'Huiii, wo fahr ich hin?!', '🛼'],
    ['z_kleber', 'Klebe-Sitzfläche', 'sticky', 'klebeband', 'Ich komm nicht mehr hoch!', '🍯'],
    ['z_klapp', 'Zusammenklapp-Sandwich', 'squash', 'klebeband', 'Ich bin ein Sandwich!', '🥪'],
    ['z_massage', 'Massage-Turbo', 'shake', 'fernbedienung', 'Viel zu viel Massage!', '💆']
  ]],
  papier: ['Papier- & Kassen-Streiche', [
    ['p_konfetti', 'Konfetti-Papierstau', 'confetti', 'fernbedienung', 'Papierstau des Grauens!', '🎊'],
    ['p_tacker', 'Tacker-Alarm', 'bonk', 'klebeband', 'Aua, der Tacker!', '📎'],
    ['p_toner', 'Toner-Wolke', 'soot', 'seife', 'Ich seh nur noch schwarz!', '💨'],
    ['p_endlos', 'Endlos-Ausdruck', 'tangle', 'klebeband', 'Das Papier hört nie auf!', '📜'],
    ['p_krawatte', 'Krawatten-Schnapper', 'sticky', 'klebeband', 'Lass meine Krawatte los!', '👔'],
    ['p_flieger', 'Papierflieger-Staffel', 'bonk', 'fernbedienung', 'Angriff der Papierflieger!', '✈️'],
    ['p_blitz', 'Blitzlicht-Kopie', 'spin', 'chili', 'Ich seh Sterne!', '📸']
  ]],
  medizin: ['Medizin-Streiche', [
    ['m_mumie', 'Mullbinden-Wickelmaschine', 'mummy', 'klebeband', 'Wer hat hier die Mullbinden verlegt?!', '🧟'],
    ['m_pflaster', 'Quietsch-Pflaster-Salve', 'bonk', 'klebeband', 'Pflaster überall!', '🩹'],
    ['m_desinfekt', 'Desinfektions-Schaumbad', 'foam', 'seife', 'Jetzt bin ich keimfrei!', '🫧'],
    ['m_juck', 'Juckpulver-Talkum', 'shake', 'chili', 'Es juckt! Es juckt!', '😖'],
    ['m_rollstuhl', 'Rollstuhl-Turbo-Schubser', 'launch', 'fernbedienung', 'Rollstuhl-Rallye!', '🛞'],
    ['m_glitzer', 'Röntgen-Glitzerblitz', 'spin', 'fernbedienung', 'Ich glitzere von innen!', '✨'],
    ['m_handschuh', 'Gummihandschuh-Schnalzer', 'bonk', 'seife', 'Schnalz! Autsch!', '🧤']
  ]],
  technik: ['Smart-Home-Streiche', [
    ['t_rollladen', 'Smart-Rollladen-Sandwich', 'squash', 'fernbedienung', 'Rollladen runter, ich bin drunter!', '🪟'],
    ['t_blubber', 'Whirlpool-Blubber-Fontäne', 'wet', 'seife', 'Blubb-blubb-blubb!', '🫧'],
    ['t_rauch', 'Grill-Rauchwolke', 'soot', 'chili', 'Ich bin geräuchert!', '💨'],
    ['t_bass', 'Heimkino-Bass-Wumms', 'launch', 'fernbedienung', 'Bass! Wumms! Weg bin ich!', '🔊'],
    ['t_disco', 'Sprachassistent-Disco', 'spin', 'fernbedienung', 'Ich will nicht tanzen!', '🪩'],
    ['t_sprenger', 'Rasensprenger-Überraschung', 'wet', 'seife', 'Wer hat den Sprenger angedreht?!', '🚿'],
    ['t_mixer', 'Smoothie-Mixer-Explosion', 'paint', 'chili', 'Bananen-Erdbeer-Gesicht!', '🍓']
  ]],
  baumarkt: ['Baumarkt-Streiche', [
    ['b_regenbogen', 'Farbmischer-Regenbogendusche', 'paint', 'seife', 'Ich bin ein Regenbogen!', '🌈'],
    ['b_schlange', 'Gartenschlauch-Schlange', 'wet', 'fernbedienung', 'Der Schlauch lebt!', '🐍'],
    ['b_kissen', 'Hochregal-Kissenlawine', 'bonk', 'klebeband', 'Kissen-Lawine!', '🛏️'],
    ['b_springteufel', 'Paket-Springteufel', 'launch', 'fernbedienung', 'Huch! Ein Springteufel!', '🤡'],
    ['b_kleister', 'Kleister-Pfütze', 'sticky', 'klebeband', 'Ich steck im Kleister!', '🍯'],
    ['b_murmeln', 'Schrauben-Murmel-Rutsche', 'slip', 'seife', 'Huiii, Murmelbahn!', '🔩'],
    ['b_spaene', 'Sägespäne-Wirbel', 'soot', 'chili', 'Hatschi! Sägespäne!', '🪵']
  ]],
  roboter: ['Roboter-Streiche', [
    ['r_schienbein', 'Saugroboter-Schienbein-Angriff', 'bonk', 'fernbedienung', 'Aua, mein Schienbein!', '🦵'],
    ['r_rempler', 'Turbo-Rempler', 'launch', 'fernbedienung', 'Der Roboter rammt mich!', '🚀'],
    ['r_staub', 'Staubbeutel-Explosion', 'soot', 'seife', 'Hatschi! Staubwolke!', '💨'],
    ['r_hosenbein', 'Hosenbein-Ansauger', 'sticky', 'klebeband', 'Er frisst meine Hose!', '👖'],
    ['r_disco', 'Disco-Roboter', 'spin', 'fernbedienung', 'Roboter-Tanzparty!', '🪩'],
    ['r_kitzel', 'Bürsten-Kitzler', 'shake', 'chili', 'Hihi, das kitzelt!', '🪶'],
    ['r_wachs', 'Rutsch-Wachs-Spur', 'slip', 'seife', 'Frisch gewachst, oje!', '🧽']
  ]],
  moebel: ['Schrank- & Möbel-Streiche', [
    ['o_boxhandschuh', 'Feder-Boxhandschuh', 'launch', 'fernbedienung', 'Bumm! Volltreffer!', '🥊'],
    ['o_klemm', 'Klemm-Schublade', 'sticky', 'klebeband', 'Meine Finger!', '🗄️'],
    ['o_konfetti', 'Konfetti-Kanone', 'confetti', 'fernbedienung', 'Überraschung!', '🎉'],
    ['o_motten', 'Motten-Wolke', 'soot', 'seife', 'Motten! Überall Motten!', '🦋'],
    ['o_quietsch', 'Quietsch-Hammer', 'bonk', 'klebeband', 'Quietsch! Bonk!', '🔨'],
    ['o_ketchup', 'Ketchup-Spritzer', 'paint', 'chili', 'Ketchup-Attacke!', '🍅'],
    ['o_kitzelfeder', 'Kitzelfeder-Falle', 'shake', 'seife', 'Hihihi, aufhören!', '🪶']
  ]]
};
const MASTER_TRAPS = [
  ['x_supernova', 'Konfetti-Supernova', 'confetti', 'fernbedienung', 'Streiche Alarm!', '🎆'],
  ['x_tsunami', 'Schaumparty-Tsunami', 'foam', 'seife', 'Schaum-Tsunami! Rette sich wer kann!', '🌊']
];
const TIERS = {
  1: { slots: [1, 2, 3], build: 1.5, stun: 4.0, pts: 100 },
  2: { slots: [4, 5, 6, 7], build: 2.5, stun: 4.0, pts: 150 },
  3: { slots: [8, 9], build: 3.5, stun: 5.0, pts: 250 }
};
const slotTier = (slot) => (slot <= 3 ? 1 : slot <= 7 ? 2 : 3);

const FAMILIES = {};
const TRAPS = {};
for (const fam in TRAP_DATA) {
  const [fname, list] = TRAP_DATA[fam];
  FAMILIES[fam] = { name: fname, traps: list.map((t) => t[0]) };
  for (const t of list) TRAPS[t[0]] = { name: t[1], family: fam, fx: t[2], item: t[3], line: t[4], icon: t[5] };
}
for (const t of MASTER_TRAPS) TRAPS[t[0]] = { name: t[1], family: 'master', fx: t[2], item: t[3], line: t[4], icon: t[5] };
TRAPS.x_supernova.extraStun = 1;
TRAPS.x_tsunami.area = 2.5;
TRAPS.m_mumie.fixedStun = 4;

const NEED_DEFS = {
  kaffee: { label: 'Kaffee', icon: '☕', types: ['kaffeeautomat'] },
  wc: { label: 'WC', icon: '🚻', types: ['wc'] },
  snack: { label: 'Snack', icon: '🍫', types: ['snackautomat'] }
};
const NEED_DEVICE_TYPES = ['kaffeeautomat', 'wc', 'snackautomat'];

const ITEMS = {
  klebeband: { name: 'Klebeband', icon: '🩹' },
  seife: { name: 'Seife', icon: '🧼' },
  chili: { name: 'Chili', icon: '🌶️' },
  fernbedienung: { name: 'Fernbedienung', icon: '🎮' }
};
const TREASURES = {
  autoschluessel: { name: 'Autoschlüssel', icon: '🔑' },
  usb: { name: 'USB-Stick', icon: '💾' },
  geheimakte: { name: 'Geheimakte', icon: '📁' }
};
const HIDE_TYPES = {
  spind: { name: 'Spind', icon: '🚪', color: '#607d8b' },
  schreibtisch: { name: 'Schreibtisch', icon: '🗃️', color: '#a1887f' },
  vorhang: { name: 'Vorhang', icon: '🎭', color: '#c62828' },
  karton: { name: 'Riesenkarton', icon: '📦', color: '#c8a165' }
};
const DECOR_TYPES = {
  pflanze: { name: 'Zimmerpflanze', color: '#43a047', h: 0.9 },
  tisch: { name: 'Tisch', color: '#bcaaa4', h: 0.55 },
  regal: { name: 'Regal', color: '#8d6e63', h: 1.4 },
  kiste: { name: 'Kiste', color: '#c8a165', h: 0.6 },
  sonnenschirm: { name: 'Sonnenschirm', color: '#ef5350', h: 1.6 },
  liege: { name: 'Sonnenliege', color: '#fafafa', h: 0.35 },
  wasserspender: { name: 'Wasserspender', color: '#81d4fa', h: 1.2 },
  tresen: { name: 'Empfangstresen', color: '#ffcc80', h: 0.9 },
  wasser: { name: 'Poolwasser', color: '#29b6f6', h: 0 },
  palme: { name: 'Palme', color: '#2e7d32', h: 1.8 },
  sofa_deko: { name: 'Sofa', color: '#7e57c2', h: 0.7 },
  lampe: { name: 'Stehlampe', color: '#ffee58', h: 1.6 }
};

const BUILDINGS = {
  buero: {
    name: 'Hightech-Büro & Co-Working-Space', short: 'Büro', icon: '🏢', price: 0, selectable: true,
    desc: 'Großraumbüro, Kaffeeküche mit Vollautomat, Kopierraum, Chef-Büro – und flitzende Saugroboter.',
    disguise: { name: 'Praktikanten-Ausweis', npc: 'praktikant' }, npcs: ['praktikant', 'chefin', 'itler'],
    wall: '#e8eaf6', wallTop: '#5c6bc0', outside: '#b0bec5',
    rooms: {
      eingang: { name: 'Empfang', floor: '#d7ccc8', floor2: '#bcaaa4', pattern: 'marble', outdoor: false },
      grossraum: { name: 'Großraumbüro', floor: '#90caf9', floor2: '#64b5f6', pattern: 'carpet', outdoor: false },
      kaffeekueche: { name: 'Kaffeeküche', floor: '#fff3e0', floor2: '#ffe0b2', pattern: 'tiles', outdoor: false },
      kopierraum: { name: 'Kopierraum', floor: '#cfd8dc', floor2: '#b0bec5', pattern: 'linoleum', outdoor: false },
      chefbuero: { name: 'Chef-Büro', floor: '#a1887f', floor2: '#8d6e63', pattern: 'wood', outdoor: false },
      konferenz: { name: 'Konferenzraum', floor: '#c5e1a5', floor2: '#aed581', pattern: 'carpet', outdoor: false },
      wc: { name: 'WC-Trakt', floor: '#e0f7fa', floor2: '#b2ebf2', pattern: 'tiles', outdoor: false },
      flur: { name: 'Flur', floor: '#eeeeee', floor2: '#e0e0e0', pattern: 'linoleum', outdoor: false }
    },
    tasks: [
      { id: 'b_kaffee', label: 'Kaffee trinken', icon: '☕', type: 'kaffeeautomat' },
      { id: 'b_kopie', label: 'Akte kopieren', icon: '🖨️', type: 'kopierer' },
      { id: 'b_schredder', label: 'Akten schreddern', icon: '🗂️', type: 'aktenvernichter' },
      { id: 'b_haende', label: 'Hände waschen', icon: '🧼', type: 'waschbecken' },
      { id: 'b_snack', label: 'Snack holen', icon: '🍫', type: 'snackautomat' },
      { id: 'b_chef', label: 'Chefsessel probesitzen', icon: '💺', type: 'chefsessel' },
      { id: 'b_praes', label: 'Präsentation starten', icon: '📽️', type: 'beamer' },
      { id: 'b_ordner', label: 'Ordner einsortieren', icon: '🗄️', type: 'aktenschrank' }
    ]
  },
  krankenhaus: {
    name: 'Modernes Krankenhaus / Ambulanz-Trakt', short: 'Krankenhaus', icon: '🏥', price: 500, selectable: true,
    desc: 'Stations-Kaffeeküche, Verbandswagen mit Mullbinden-Maschine, Röntgenraum und Wartebereich.',
    disguise: { name: 'Arztkittel', npc: 'oberarzt' }, npcs: ['oberarzt', 'pflegerin', 'patient'],
    wall: '#f1f8e9', wallTop: '#26a69a', outside: '#a5d6a7',
    rooms: {
      eingang: { name: 'Ambulanz-Eingang', floor: '#e0f2f1', floor2: '#b2dfdb', pattern: 'marble', outdoor: false },
      wartebereich: { name: 'Wartebereich', floor: '#fff9c4', floor2: '#fff59d', pattern: 'linoleum', outdoor: false },
      stationskueche: { name: 'Stations-Kaffeeküche', floor: '#ffe0b2', floor2: '#ffcc80', pattern: 'tiles', outdoor: false },
      verbandsraum: { name: 'Verbandsraum', floor: '#e1f5fe', floor2: '#b3e5fc', pattern: 'tiles', outdoor: false },
      untersuchung: { name: 'Untersuchungszimmer', floor: '#f3e5f5', floor2: '#e1bee7', pattern: 'linoleum', outdoor: false },
      roentgen: { name: 'Röntgenraum', floor: '#cfd8dc', floor2: '#b0bec5', pattern: 'linoleum', outdoor: false },
      wc: { name: 'WC', floor: '#e0f7fa', floor2: '#b2ebf2', pattern: 'tiles', outdoor: false },
      flur: { name: 'Stationsflur', floor: '#f5f5f5', floor2: '#e8f5e9', pattern: 'linoleum', outdoor: false }
    },
    tasks: [
      { id: 'k_verband', label: 'Verbandswagen prüfen', icon: '🩹', type: 'verbandswagen' },
      { id: 'k_roentgen', label: 'Röntgenbild machen', icon: '🩻', type: 'roentgen' },
      { id: 'k_desinf', label: 'Hände desinfizieren', icon: '🧴', type: 'desinfektion' },
      { id: 'k_bett', label: 'Krankenbett beziehen', icon: '🛏️', type: 'krankenbett' },
      { id: 'k_kaffee', label: 'Kaffee trinken', icon: '☕', type: 'kaffeeautomat' },
      { id: 'k_haende', label: 'Hände waschen', icon: '🧼', type: 'waschbecken' },
      { id: 'k_nummer', label: 'Wartenummer ziehen', icon: '🎫', type: 'nummernautomat' },
      { id: 'k_arznei', label: 'Arzneien zählen', icon: '💊', type: 'medikamentenschrank' }
    ]
  },
  villa: {
    name: 'Moderne Smart-Home-Villa', short: 'Villa', icon: '🏡', price: 800, selectable: true,
    desc: 'Designerküche, Heimkino, sprachgesteuerte Rollläden, Whirlpool, Grill-Terrasse und Pool.',
    disguise: { name: 'Butler-Fliege', npc: 'butler' }, npcs: ['butler', 'gaertnerin', 'influencer'],
    wall: '#fffde7', wallTop: '#8d6e63', outside: '#81c784',
    rooms: {
      eingang: { name: 'Eingangshalle', floor: '#eeeeee', floor2: '#e0e0e0', pattern: 'marble', outdoor: false },
      kueche: { name: 'Designerküche', floor: '#fafafa', floor2: '#cfd8dc', pattern: 'tiles', outdoor: false },
      wohnzimmer: { name: 'Wohnzimmer & Heimkino', floor: '#d7a86e', floor2: '#c48b4f', pattern: 'wood', outdoor: false },
      bad: { name: 'Bad mit Whirlpool', floor: '#e0f7fa', floor2: '#80deea', pattern: 'tiles', outdoor: false },
      schlafzimmer: { name: 'Schlafzimmer', floor: '#f8bbd0', floor2: '#f48fb1', pattern: 'carpet', outdoor: false },
      terrasse: { name: 'Grill-Terrasse', floor: '#bcaaa4', floor2: '#a1887f', pattern: 'deck', outdoor: true },
      pool: { name: 'Poolbereich', floor: '#e0e0e0', floor2: '#bdbdbd', pattern: 'tiles', outdoor: true },
      flur: { name: 'Flur', floor: '#e6c9a0', floor2: '#d7b386', pattern: 'wood', outdoor: false }
    },
    tasks: [
      { id: 'v_grill', label: 'Grill anheizen', icon: '🍖', type: 'grill' },
      { id: 'v_rollladen', label: 'Rollläden öffnen', icon: '🪟', type: 'rollladen' },
      { id: 'v_whirlpool', label: 'Whirlpool einschalten', icon: '🛁', type: 'whirlpool' },
      { id: 'v_film', label: 'Film starten', icon: '🎬', type: 'heimkino' },
      { id: 'v_pool', label: 'Pool abdecken', icon: '🏊', type: 'poolabdeckung' },
      { id: 'v_espresso', label: 'Espresso machen', icon: '☕', type: 'kaffeeautomat' },
      { id: 'v_kuehl', label: 'Kühlschrank auffüllen', icon: '🧊', type: 'kuehlschrank' },
      { id: 'v_sofa', label: 'Aufs Sofa fläzen', icon: '🛋️', type: 'sofa' }
    ]
  },
  baumarkt: {
    name: 'Baumarkt & Möbelhaus', short: 'Baumarkt', icon: '🔨', price: 1100, selectable: true,
    desc: 'Farbmisch-Station, Gartenschläuche, Hochregale, Kasse, Musterküchen und Paket-Abholung.',
    disguise: { name: 'Warnweste', npc: 'verkaeuferin' }, npcs: ['kunde', 'verkaeuferin', 'handwerker'],
    wall: '#fff8e1', wallTop: '#ef6c00', outside: '#bdbdbd',
    rooms: {
      eingang: { name: 'Eingang & Kasse', floor: '#e0e0e0', floor2: '#bdbdbd', pattern: 'concrete', outdoor: false },
      farbe: { name: 'Farbabteilung', floor: '#ffecb3', floor2: '#ffe082', pattern: 'concrete', outdoor: false },
      garten: { name: 'Gartenabteilung', floor: '#aed581', floor2: '#9ccc65', pattern: 'grass', outdoor: false },
      lager: { name: 'Hochregal-Lager', floor: '#cfd8dc', floor2: '#b0bec5', pattern: 'concrete', outdoor: false },
      musterkueche: { name: 'Musterküchen-Ausstellung', floor: '#d7ccc8', floor2: '#bcaaa4', pattern: 'wood', outdoor: false },
      paket: { name: 'Paket-Abholung', floor: '#fff9c4', floor2: '#fff176', pattern: 'linoleum', outdoor: false },
      wc: { name: 'Kundentoilette', floor: '#e0f7fa', floor2: '#b2ebf2', pattern: 'tiles', outdoor: false },
      flur: { name: 'Hauptgang', floor: '#eceff1', floor2: '#cfd8dc', pattern: 'concrete', outdoor: false }
    },
    tasks: [
      { id: 'm_farbe', label: 'Farbe mischen', icon: '🎨', type: 'farbmischer' },
      { id: 'm_schlauch', label: 'Schlauch testen', icon: '💦', type: 'gartenschlauch' },
      { id: 'm_regal', label: 'Regal prüfen', icon: '📦', type: 'hochregal' },
      { id: 'm_paket', label: 'Paket abholen', icon: '📮', type: 'paketautomat' },
      { id: 'm_kasse', label: 'An der Kasse bezahlen', icon: '🧾', type: 'kasse' },
      { id: 'm_kueche', label: 'Musterküche bestaunen', icon: '🍳', type: 'musterkueche' },
      { id: 'm_kaffee', label: 'Kaffee trinken', icon: '☕', type: 'kaffeeautomat' },
      { id: 'm_werkzeug', label: 'Werkzeug holen', icon: '🔧', type: 'werkbank' }
    ]
  },
  uebung: {
    name: 'Übungsplatz', short: 'Übung', icon: '🎯', price: 0, selectable: false,
    desc: 'Kleiner Übungsplatz zum Warmspielen in der Lobby.',
    disguise: { name: 'Praktikanten-Ausweis', npc: 'praktikant' }, npcs: ['dummy'],
    wall: '#ede7f6', wallTop: '#7e57c2', outside: '#c5cae9',
    rooms: {
      halle: { name: 'Übungshalle', floor: '#ffe0b2', floor2: '#ffcc80', pattern: 'wood', outdoor: false },
      kammer: { name: 'Übungskammer', floor: '#c5cae9', floor2: '#9fa8da', pattern: 'tiles', outdoor: false }
    },
    tasks: [
      { id: 'u_kaffee', label: 'Kaffee trinken', icon: '☕', type: 'kaffeeautomat' },
      { id: 'u_snack', label: 'Snack holen', icon: '🍫', type: 'snackautomat' }
    ]
  }
};

// Rauminhalte (serverintern): Geräte an Wänden, Verstecke, Deko; *C = in der Raummitte
const ROOM_CONTENT = {
  buero: {
    eingang: { dev: ['snackautomat'], decor: ['tresen', 'pflanze', 'pflanze'] },
    grossraum: { dev: ['buerostuhl', 'buerostuhl', 'saugroboter'], hideC: ['schreibtisch', 'schreibtisch'], decor: ['pflanze'], repeat: true },
    kaffeekueche: { dev: ['kaffeeautomat', 'snackautomat', 'waschbecken'], decorC: ['tisch'] },
    kopierraum: { dev: ['kopierer', 'aktenvernichter', 'aktenschrank'], decor: ['regal'] },
    chefbuero: { dev: ['chefsessel', 'aktenschrank'], hideC: ['schreibtisch'], decor: ['pflanze', 'lampe'] },
    konferenz: { dev: ['beamer', 'buerostuhl'], decorC: ['tisch'], decor: ['pflanze'], repeat: true },
    wc: { dev: ['wc', 'waschbecken'], hide: ['spind'] },
    flur: { decor: ['pflanze', 'wasserspender'], hide: ['spind'] }
  },
  krankenhaus: {
    eingang: { dev: ['desinfektion', 'nummernautomat'], decor: ['tresen', 'pflanze'] },
    wartebereich: { dev: ['wartestuhl', 'wartestuhl', 'snackautomat'], hide: ['vorhang'], decor: ['pflanze'], repeat: true },
    stationskueche: { dev: ['kaffeeautomat', 'waschbecken'], decorC: ['tisch'] },
    verbandsraum: { dev: ['verbandswagen', 'medikamentenschrank'], decor: ['regal'] },
    untersuchung: { dev: ['krankenbett', 'desinfektion'], hide: ['vorhang'], repeat: true },
    roentgen: { dev: ['roentgen'], hide: ['spind'], decor: ['pflanze'] },
    wc: { dev: ['wc', 'waschbecken'] },
    flur: { decor: ['pflanze', 'wasserspender'], hide: ['spind'] }
  },
  villa: {
    eingang: { dev: ['kommode', 'rollladen'], hide: ['vorhang'], decor: ['pflanze', 'lampe'] },
    kueche: { dev: ['kaffeeautomat', 'kuehlschrank', 'snackautomat'], decorC: ['tisch'] },
    wohnzimmer: { dev: ['heimkino', 'sofa', 'rollladen', 'saugroboter'], hide: ['vorhang'], decor: ['lampe', 'pflanze'], repeat: true },
    bad: { dev: ['wc', 'waschbecken', 'whirlpool'] },
    schlafzimmer: { dev: ['kommode', 'rollladen'], hide: ['spind'], decor: ['lampe'], repeat: true },
    terrasse: { dev: ['grill'], decor: ['sonnenschirm', 'pflanze'] },
    pool: { dev: ['poolabdeckung'], decor: ['liege', 'liege'], water: true },
    flur: { decor: ['pflanze', 'sofa_deko'], hide: ['vorhang'] }
  },
  baumarkt: {
    eingang: { dev: ['kasse', 'snackautomat'], decor: ['pflanze'] },
    farbe: { dev: ['farbmischer', 'hochregal'], decor: ['kiste'] },
    garten: { dev: ['gartenschlauch'], decor: ['pflanze', 'palme', 'pflanze'], repeat: true },
    lager: { dev: ['hochregal', 'hochregal'], hide: ['karton'], decor: ['kiste'], repeat: true },
    musterkueche: { dev: ['musterkueche', 'kaffeeautomat', 'waschbecken'] },
    paket: { dev: ['paketautomat'], hide: ['karton'], decor: ['kiste'] },
    wc: { dev: ['wc', 'waschbecken'] },
    flur: { dev: ['werkbank'], decor: ['kiste'], hide: ['karton'] }
  },
  uebung: {
    halle: { dev: ['kaffeeautomat', 'snackautomat', 'buerostuhl'], hide: ['spind'], decor: ['pflanze'] },
    kammer: { dev: ['wc', 'waschbecken'], decor: ['pflanze'] }
  }
};
// Pflichträume je Trakt (enthalten Kaffee/WC/Snack)
const REQUIRED_ROOMS = {
  buero: ['kaffeekueche', 'wc'],
  krankenhaus: ['stationskueche', 'wc', 'wartebereich'],
  villa: ['kueche', 'bad'],
  baumarkt: ['musterkueche', 'wc']
};

const NPC_TYPES = {
  praktikant: { name: 'Praktikant', look: { skin: 1, hair: 'wuschel', hairColor: 3, face: 'staunend', outfit: 'hemd', outfitColor: 2, acc: 'ausweis' } },
  chefin: { name: 'Chefin', look: { skin: 0, hair: 'dutt', hairColor: 0, face: 'cool', outfit: 'anzug', outfitColor: 7, acc: 'brille' } },
  itler: { name: 'IT-Kollege', look: { skin: 2, hair: 'kurz', hairColor: 1, face: 'vollbart', outfit: 'hoodie', outfitColor: 5, acc: 'kopfhoerer' } },
  oberarzt: { name: 'Oberarzt', look: { skin: 1, hair: 'seitenscheitel', hairColor: 6, face: 'schnurrbart', outfit: 'arztkittel', outfitColor: 9, acc: 'stethoskop' } },
  pflegerin: { name: 'Pflegerin', look: { skin: 3, hair: 'zopf', hairColor: 1, face: 'grinsen', outfit: 'kleid', outfitColor: 4, acc: 'ausweis' } },
  patient: { name: 'Patient', look: { skin: 0, hair: 'glatze', hairColor: 7, face: 'staunend', outfit: 'bademantel', outfitColor: 3, acc: 'keins' } },
  butler: { name: 'Butler', look: { skin: 0, hair: 'seitenscheitel', hairColor: 0, face: 'schnurrbart', outfit: 'butler', outfitColor: 0, acc: 'keins' } },
  gaertnerin: { name: 'Gärtnerin', look: { skin: 2, hair: 'zopf', hairColor: 4, face: 'sommersprossen', outfit: 'latzhose', outfitColor: 5, acc: 'basecap' } },
  influencer: { name: 'Influencer', look: { skin: 4, hair: 'irokese', hairColor: 5, face: 'cool', outfit: 'trainingsanzug', outfitColor: 6, acc: 'sonnenbrille' } },
  kunde: { name: 'Baumarkt-Kunde', look: { skin: 1, hair: 'kurz', hairColor: 2, face: 'vollbart', outfit: 'hemd', outfitColor: 8, acc: 'basecap' } },
  verkaeuferin: { name: 'Verkäuferin', look: { skin: 2, hair: 'lang', hairColor: 3, face: 'grinsen', outfit: 'warnweste', outfitColor: 1, acc: 'ausweis' } },
  handwerker: { name: 'Handwerker', look: { skin: 3, hair: 'kurz', hairColor: 0, face: 'schnurrbart', outfit: 'latzhose', outfitColor: 2, acc: 'bauhelm' } },
  dummy: { name: 'Übungs-Didi', look: { skin: 1, hair: 'locken', hairColor: 4, face: 'grinsen', outfit: 'trainingsanzug', outfitColor: 3, acc: 'stirnband' } }
};

const AVATAR = {
  skins: ['#ffdbb5', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3a1e'],
  hairColors: ['#2b1b10', '#5a3a1e', '#a0522d', '#e6be8a', '#d35400', '#8e44ad', '#9e9e9e', '#f5f5f5'],
  outfitColors: ['#1e88e5', '#e53935', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#37474f', '#ec407a', '#ffffff'],
  hair: [
    { id: 'kurz', name: 'Kurzhaar' }, { id: 'seitenscheitel', name: 'Seitenscheitel' }, { id: 'lang', name: 'Lange Haare' },
    { id: 'locken', name: 'Locken' }, { id: 'dutt', name: 'Dutt' }, { id: 'zopf', name: 'Zopf' }, { id: 'irokese', name: 'Irokese' },
    { id: 'glatze', name: 'Glatze' }, { id: 'wuschel', name: 'Wuschelkopf' }, { id: 'afro', name: 'Afro' }
  ],
  face: [
    { id: 'grinsen', name: 'Grinsen' }, { id: 'frech', name: 'Frech' }, { id: 'staunend', name: 'Staunend' }, { id: 'cool', name: 'Cool' },
    { id: 'schnurrbart', name: 'Schnurrbart' }, { id: 'sommersprossen', name: 'Sommersprossen' }, { id: 'vollbart', name: 'Vollbart' }
  ],
  outfit: [
    { id: 'hemd', name: 'Hemd' }, { id: 'hoodie', name: 'Hoodie' }, { id: 'anzug', name: 'Anzug' }, { id: 'arztkittel', name: 'Arztkittel' },
    { id: 'latzhose', name: 'Latzhose' }, { id: 'warnweste', name: 'Warnweste' }, { id: 'pyjama', name: 'Pyjama' }, { id: 'kleid', name: 'Kleid' },
    { id: 'trainingsanzug', name: 'Trainingsanzug' }, { id: 'bademantel', name: 'Bademantel' }, { id: 'schuerze', name: 'Schürze' },
    { id: 'butler', name: 'Butler-Frack' }
  ],
  acc: [
    { id: 'keins', name: 'Nichts' }, { id: 'brille', name: 'Brille' }, { id: 'sonnenbrille', name: 'Sonnenbrille' }, { id: 'basecap', name: 'Basecap' },
    { id: 'bauhelm', name: 'Bauhelm' }, { id: 'zylinder', name: 'Zylinder' }, { id: 'kopfhoerer', name: 'Kopfhörer' }, { id: 'stirnband', name: 'Stirnband' },
    { id: 'krone', name: 'Krone' }, { id: 'stethoskop', name: 'Stethoskop' }, { id: 'ausweis', name: 'Mitarbeiter-Ausweis' }
  ]
};
const EMOTES = ['😂', '☕', '🤕', '👀', '🤡', '😈', '🙈', '🎉', '🔥', '🫣'];
const PERKS = {
  meisterhirn: { name: 'Meister-Hirn', icon: '🧠', desc: 'Du siehst ein dezentes Symbol an deinen eigenen Fallen – nie wieder ins eigene Fettnäpfchen!' },
  leise: { name: 'Leise Sohlen', icon: '🥿', desc: 'Deine Schritte erzeugen hinter Wänden keine Schallwellen mehr.' },
  flink: { name: 'Flinke Finger', icon: '⚡', desc: 'Du baust Fallen 25 % schneller.' }
};

const SHOP = {
  slot4: { name: 'Rad-Slot 4', cat: 'rad', price: 300, icon: '🎡', minLevel: 1, desc: 'Schaltet den 4. Streich auf jedem Fallen-Rad frei.' },
  slot5: { name: 'Rad-Slot 5', cat: 'rad', price: 450, icon: '🎡', minLevel: 1, desc: 'Schaltet den 5. Streich auf jedem Fallen-Rad frei.' },
  slot6: { name: 'Rad-Slot 6', cat: 'rad', price: 600, icon: '🎡', minLevel: 1, desc: 'Schaltet den 6. Streich auf jedem Fallen-Rad frei.' },
  slot7: { name: 'Rad-Slot 7', cat: 'rad', price: 800, icon: '🎡', minLevel: 1, desc: 'Schaltet den 7. Streich auf jedem Fallen-Rad frei – das volle 7er-Rad!' },
  master: { name: '9er-Meisterrad', cat: 'rad', price: 1500, icon: '👑', minLevel: 5, desc: 'Zwei Meister-Streiche: Konfetti-Supernova und Schaumparty-Tsunami (Flächeneffekt!).' },
  'perk:meisterhirn': { name: 'Meister-Hirn', cat: 'perk', price: 900, icon: '🧠', minLevel: 3, desc: PERKS.meisterhirn.desc },
  'perk:leise': { name: 'Leise Sohlen', cat: 'perk', price: 600, icon: '🥿', minLevel: 1, desc: PERKS.leise.desc },
  'perk:flink': { name: 'Flinke Finger', cat: 'perk', price: 700, icon: '⚡', minLevel: 1, desc: PERKS.flink.desc },
  'bld:krankenhaus': { name: 'Krankenhaus', cat: 'gebaeude', price: 500, icon: '🏥', minLevel: 1, desc: BUILDINGS.krankenhaus.desc },
  'bld:villa': { name: 'Smart-Home-Villa', cat: 'gebaeude', price: 800, icon: '🏡', minLevel: 1, desc: BUILDINGS.villa.desc },
  'bld:baumarkt': { name: 'Baumarkt & Möbelhaus', cat: 'gebaeude', price: 1100, icon: '🔨', minLevel: 1, desc: BUILDINGS.baumarkt.desc }
};
const COSMETIC_PRICES = {
  hair: { dutt: 150, zopf: 150, wuschel: 200, afro: 250, irokese: 350 },
  face: { cool: 150, sommersprossen: 120, schnurrbart: 200, vollbart: 250 },
  outfit: { anzug: 300, arztkittel: 350, warnweste: 250, pyjama: 200, kleid: 250, trainingsanzug: 200, bademantel: 300, schuerze: 150, butler: 500 },
  acc: { sonnenbrille: 200, bauhelm: 250, zylinder: 400, kopfhoerer: 250, stirnband: 120, krone: 600, stethoskop: 300, ausweis: 100 }
};
const COSMETIC_ICONS = { hair: '💇', face: '😃', outfit: '👕', acc: '🎩' };
for (const cat in COSMETIC_PRICES) {
  for (const id in COSMETIC_PRICES[cat]) {
    const def = AVATAR[cat].find((x) => x.id === id);
    SHOP[cat + ':' + id] = { name: def ? def.name : id, cat, price: COSMETIC_PRICES[cat][id], icon: COSMETIC_ICONS[cat], minLevel: 1, desc: 'Für deinen Charakter.' };
  }
}
const EMOTE_PRICES = { '🤡': 150, '😈': 150, '🙈': 150, '🎉': 200, '🔥': 200, '🫣': 250 };
for (const e in EMOTE_PRICES) SHOP['emote:' + e] = { name: 'Emote ' + e, cat: 'emote', price: EMOTE_PRICES[e], icon: e, minLevel: 1, desc: 'Ein neues Emoji für die Emoji-Leiste.' };

const XP_PER_LEVEL = 150;
// Optional (z. B. für Tests): feste Rundendauer in Sekunden für alle Modi
const ROUND_OVERRIDE = parseInt(process.env.ROUND_SECONDS, 10) || 0;

const MODES = {
  checkliste: { name: 'Feierabend-Checkliste', icon: '✅', desc: 'Jeder bekommt 4 Alltagsaufgaben. Wer zuerst alles erledigt und durch den Ausgang entkommt, gewinnt!', min: 2, selectable: true },
  schatzsuche: { name: 'Agenten-Schatzsuche', icon: '🕵️', desc: '3 geheime Gegenstände sind in Geräten versteckt. Sammle alle 3 und renn zum Ausgang – wer in eine Falle tappt, verliert einen!', min: 2, selectable: true },
  teams: { name: '2 vs. 2 Team-Sabotage', icon: '⚔️', desc: 'Zwei Teams, zwei Trakte. Schleich dich ins gegnerische Revier, sabotiere die Geräte und sammle Team-Punkte!', min: 4, selectable: true },
  chaos: { name: 'Chaos-Punktejagd', icon: '💥', desc: '3 oder 5 Minuten freies Chaos – wer die meisten Streiche auslöst und die höchsten Schadenfreude-Kombos holt, wird Prank-Champion!', min: 2, selectable: true },
  uebung: { name: 'Übungsplatz', icon: '🎯', desc: 'Warmspielen in der Lobby.', min: 1, selectable: false }
};
const MODE_DURATION = { checkliste: 480, schatzsuche: 480, teams: 300 };

const TEAMS = [{ name: 'Team Blau', color: '#3b82f6' }, { name: 'Team Orange', color: '#f97316' }];

const FREE_PARTS = {
  hair: ['kurz', 'seitenscheitel', 'lang', 'locken', 'glatze'],
  face: ['grinsen', 'frech', 'staunend'],
  outfit: ['hemd', 'hoodie', 'latzhose'],
  acc: ['keins', 'brille', 'basecap']
};

const CATALOG = {
  version: 1,
  needs: NEED_DEFS,
  deviceTypes: DEVICE_TYPES,
  families: FAMILIES,
  masterTraps: MASTER_TRAPS.map((t) => t[0]),
  traps: TRAPS,
  tiers: TIERS,
  fxTypes: FX_TYPES,
  items: ITEMS,
  treasures: TREASURES,
  hideTypes: HIDE_TYPES,
  decorTypes: DECOR_TYPES,
  buildings: BUILDINGS,
  modes: MODES,
  npcTypes: NPC_TYPES,
  teams: TEAMS,
  avatar: AVATAR,
  emotes: EMOTES,
  perks: PERKS,
  shop: SHOP,
  xpPerLevel: XP_PER_LEVEL
};

const BOT_NAMES = ['Bot Bernd', 'Bot Gerti', 'Bot Hias', 'Bot Resi', 'Bot Ferdl', 'Bot Mitzi'];

const DAILY_POOL = [
  { id: 'trapsBuilt', goals: [3, 5, 8], text: (n) => `Lege ${n} Fallen` },
  { id: 'playerHits', goals: [2, 3, 5], text: (n) => `Lass ${n} Mitspieler in deine Fallen tappen` },
  { id: 'npcHits', goals: [1, 2, 3], text: (n) => `Lass ${n} ${n === 1 ? 'NPC' : 'NPCs'} in deine Fallen tappen` },
  { id: 'needs', goals: [4, 6, 10], text: (n) => `Erfülle ${n} Bedürfnisse` },
  { id: 'wins', goals: [1, 1, 2], text: (n) => `Gewinne ${n} ${n === 1 ? 'Runde' : 'Runden'}` },
  { id: 'hides', goals: [2, 3, 5], text: (n) => `Verstecke dich ${n}-mal` },
  { id: 'waves', goals: [1, 2, 3], text: (n) => `Locke ${n} ${n === 1 ? 'NPC' : 'NPCs'} per Winken an` },
  { id: 'rounds', goals: [2, 3, 4], text: (n) => `Spiele ${n} Runden` }
];

/* ---------------------------------------------------------------------
 *  PERSISTENZ – players.json (atomar, debounced)
 * ------------------------------------------------------------------- */
const DB = { players: {} };
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
let saveTimer = null;
let dirty = false;

function loadDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(PLAYERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
      if (raw && typeof raw === 'object' && raw.players) DB.players = raw.players;
    }
    console.log(`[Daten] ${Object.keys(DB.players).length} Spielstände geladen aus ${PLAYERS_FILE}`);
  } catch (e) {
    console.error('[Daten] Laden fehlgeschlagen:', e.message);
  }
}
function saveDbNow() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = PLAYERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ players: DB.players }));
    fs.renameSync(tmp, PLAYERS_FILE);
    dirty = false;
  } catch (e) {
    console.error('[Daten] Speichern fehlgeschlagen:', e.message);
  }
}
function saveSoon() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveDbNow(); }, 3000);
}

/* ---------------------------------------------------------------------
 *  KONTEN – Name + 4-stelliger Code
 * ------------------------------------------------------------------- */
function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 16) return null;
  if (!/^[\p{L}\p{N} ._\-]+$/u.test(n)) return null;
  return n;
}
function codeProblem(code) {
  if (typeof code !== 'string' || !/^\d{4}$/.test(code)) return 'Der Code muss aus genau 4 Ziffern bestehen.';
  const d = code.split('').map(Number);
  if (d.every((x) => x === d[0])) return 'Zu einfach: lauter gleiche Ziffern sind nicht erlaubt.';
  let asc = true, desc = true;
  for (let i = 1; i < 4; i++) {
    if ((d[i - 1] + 1) % 10 !== d[i]) asc = false;
    if ((d[i - 1] + 9) % 10 !== d[i]) desc = false;
  }
  if (asc || desc) return 'Zu einfach: Zahlenfolgen wie 1234 oder 9876 sind nicht erlaubt.';
  if (d[0] === d[2] && d[1] === d[3]) return 'Zu einfach: Muster wie 1212 sind nicht erlaubt.';
  if (d[0] === d[1] && d[2] === d[3]) return 'Zu einfach: Muster wie 1122 sind nicht erlaubt.';
  return null;
}
function suggestCode() {
  for (let i = 0; i < 200; i++) {
    const c = String(randInt(0, 9999)).padStart(4, '0');
    if (!codeProblem(c)) return c;
  }
  return '7842';
}
function hashCode(salt, name, code) {
  return crypto.createHash('sha256').update(salt + '|' + name.toLowerCase() + '|' + code).digest('hex');
}
function randomAvatar(allParts) {
  const P = allParts ? null : FREE_PARTS;
  return {
    skin: randInt(0, AVATAR.skins.length - 1),
    hair: P ? pick(P.hair) : pick(AVATAR.hair).id,
    hairColor: randInt(0, AVATAR.hairColors.length - 1),
    face: P ? pick(P.face) : pick(AVATAR.face).id,
    outfit: P ? pick(P.outfit) : pick(AVATAR.outfit).id,
    outfitColor: randInt(0, AVATAR.outfitColors.length - 1),
    acc: P ? pick(P.acc) : pick(AVATAR.acc).id
  };
}
function owns(rec, shopId) {
  if (!SHOP[shopId]) return true; // nicht im Shop = gratis
  if (/^slot\d$/.test(shopId)) return (rec.slots || 3) >= parseInt(shopId.slice(4), 10);
  if (shopId === 'master') return !!rec.master;
  return Array.isArray(rec.unlocked) && rec.unlocked.includes(shopId);
}
function ownsBuilding(rec, bld) {
  if (!BUILDINGS[bld] || !BUILDINGS[bld].selectable) return false;
  if (bld === 'buero') return true;
  return !!rec && owns(rec, 'bld:' + bld);
}
function sanitizeAvatar(av, rec, fallback) {
  const base = fallback || randomAvatar(false);
  const out = Object.assign({}, base);
  if (!av || typeof av !== 'object') return out;
  const isOwned = (cat, id) => !rec || owns(rec, cat + ':' + id);
  if (Number.isInteger(av.skin) && av.skin >= 0 && av.skin < AVATAR.skins.length) out.skin = av.skin;
  if (Number.isInteger(av.hairColor) && av.hairColor >= 0 && av.hairColor < AVATAR.hairColors.length) out.hairColor = av.hairColor;
  if (Number.isInteger(av.outfitColor) && av.outfitColor >= 0 && av.outfitColor < AVATAR.outfitColors.length) out.outfitColor = av.outfitColor;
  for (const cat of ['hair', 'face', 'outfit', 'acc']) {
    const v = av[cat];
    if (typeof v === 'string' && AVATAR[cat].some((x) => x.id === v) && isOwned(cat, v)) out[cat] = v;
  }
  return out;
}
function defaultStats() {
  return { rounds: 0, wins: 0, points: 0, trapsBuilt: 0, playerHits: 0, npcHits: 0, needs: 0, hides: 0, waves: 0 };
}
function newRecord(name, code) {
  const salt = crypto.randomBytes(8).toString('hex');
  return {
    name, salt, hash: hashCode(salt, name, code),
    level: 1, xp: 0, coins: 150,
    avatar: randomAvatar(false),
    unlocked: [], slots: 3, master: false, perk: null,
    stats: defaultStats(), daily: null,
    created: Date.now(), seen: Date.now()
  };
}
function applyRestore(rec, restore) {
  if (!restore || typeof restore !== 'object') return;
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? clamp(Math.floor(v), lo, hi) : d);
  rec.level = num(restore.level, 1, 60, 1);
  rec.xp = num(restore.xp, 0, XP_PER_LEVEL - 1, 0);
  rec.coins = num(restore.coins, 0, 50000, rec.coins);
  if (Array.isArray(restore.unlocked)) rec.unlocked = restore.unlocked.filter((id) => typeof id === 'string' && SHOP[id] && !/^slot\d$/.test(id) && id !== 'master').slice(0, 200);
  rec.slots = num(restore.slots, 3, 7, 3);
  rec.master = !!restore.master && rec.slots >= 7;
  if (restore.stats && typeof restore.stats === 'object') {
    for (const k in rec.stats) rec.stats[k] = num(restore.stats[k], 0, 1e7, 0);
  }
  rec.avatar = sanitizeAvatar(restore.avatar, rec, rec.avatar);
  if (typeof restore.perk === 'string' && PERKS[restore.perk] && owns(rec, 'perk:' + restore.perk)) rec.perk = restore.perk;
}

/* Tägliche Herausforderungen – deterministisch aus dem Datum */
function dailyFor(date) {
  const rnd = seededRandom(hashStr('streiche-alarm-' + date));
  const pool = DAILY_POOL.slice();
  const list = [];
  while (list.length < 3 && pool.length) {
    const i = Math.floor(rnd() * pool.length);
    const d = pool.splice(i, 1)[0];
    const goal = d.goals[Math.floor(rnd() * d.goals.length)];
    list.push({ id: d.id, text: d.text(goal), goal, prog: 0, done: false });
  }
  return { date, list };
}
function ensureDaily(rec) {
  const today = viennaDate();
  if (!rec.daily || rec.daily.date !== today || !Array.isArray(rec.daily.list)) rec.daily = dailyFor(today);
  return rec.daily;
}
function addXp(rec, xp) {
  rec.xp = (rec.xp || 0) + Math.max(0, Math.round(xp));
  let up = false;
  while (rec.xp >= XP_PER_LEVEL) {
    rec.xp -= XP_PER_LEVEL;
    rec.level = (rec.level || 1) + 1;
    rec.coins += 30;
    up = true;
  }
  return up;
}
/* Statistik erhöhen + Tagesziel prüfen. Gibt Liste neu erledigter Tagesziele zurück. */
function bumpStat(rec, stat, n) {
  if (!rec || !n) return [];
  rec.stats = rec.stats || defaultStats();
  rec.stats[stat] = (rec.stats[stat] || 0) + n;
  const done = [];
  const daily = ensureDaily(rec);
  for (const d of daily.list) {
    if (d.id === stat && !d.done) {
      d.prog = Math.min(d.goal, d.prog + n);
      if (d.prog >= d.goal) {
        d.done = true;
        rec.coins += 60;
        addXp(rec, 80);
        done.push(d.text);
      }
    }
  }
  saveSoon();
  return done;
}
function profileOut(rec, code) {
  if (!rec) return null;
  ensureDaily(rec);
  return {
    name: rec.name, code: code || null,
    level: rec.level, xp: rec.xp, xpNext: XP_PER_LEVEL, coins: rec.coins,
    avatar: rec.avatar, unlocked: rec.unlocked.slice(), slots: rec.slots, master: rec.master, perk: rec.perk,
    stats: Object.assign({}, rec.stats),
    daily: { date: rec.daily.date, list: rec.daily.list.map((d) => Object.assign({}, d)) }
  };
}
function shopBuy(rec, id) {
  const item = SHOP[id];
  if (!item) return 'Diesen Artikel gibt es nicht.';
  if (owns(rec, id)) return 'Das hast du schon freigeschaltet.';
  if ((rec.level || 1) < (item.minLevel || 1)) return `Dafür brauchst du Level ${item.minLevel}.`;
  if (/^slot\d$/.test(id)) {
    const n = parseInt(id.slice(4), 10);
    if ((rec.slots || 3) !== n - 1) return `Schalte zuerst Rad-Slot ${n - 1} frei.`;
  }
  if (id === 'master' && (rec.slots || 3) < 7) return 'Das Meisterrad gibt es erst mit vollem 7er-Rad.';
  if (rec.coins < item.price) return `Dir fehlen noch ${item.price - rec.coins} Chaos-Münzen.`;
  rec.coins -= item.price;
  if (/^slot\d$/.test(id)) rec.slots = parseInt(id.slice(4), 10);
  else if (id === 'master') rec.master = true;
  else rec.unlocked.push(id);
  saveSoon();
  return null;
}

/* Brute-Force-Schutz pro IP */
const loginFails = new Map();
function loginBlocked(ip) {
  const f = loginFails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 10 * 60 * 1000) { loginFails.delete(ip); return false; }
  return f.count >= 8;
}
function loginFailed(ip) {
  const f = loginFails.get(ip);
  if (!f || Date.now() - f.first > 10 * 60 * 1000) loginFails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

/* Bestenliste (kurz zwischengespeichert) */
let lbCache = null, lbTime = 0;
function leaderboard() {
  if (lbCache && Date.now() - lbTime < 5000) return lbCache;
  lbCache = Object.values(DB.players)
    .filter((r) => r.stats && (r.stats.points > 0 || r.stats.wins > 0))
    .sort((a, b) => (b.stats.points - a.stats.points) || (b.stats.wins - a.stats.wins) || (b.level - a.level))
    .slice(0, 50)
    .map((r) => ({ name: r.name, level: r.level, points: r.stats.points, wins: r.stats.wins, avatar: r.avatar }));
  lbTime = Date.now();
  return lbCache;
}

/* ---------------------------------------------------------------------
 *  KARTE – Kachelraster, Kollision, Wegfindung (A*), Sichtbarkeit
 * ------------------------------------------------------------------- */
const T_VOID = 0, T_FLOOR = 1, T_WALL = 2, T_DOOR = 3, T_EXIT = 4;
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = k[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

class GameMap {
  constructor(o) {
    Object.assign(this, o);
    this.doorAt = new Map();
    for (const d of this.doors) this.doorAt.set(d.y * this.w + d.x, [d.a, d.b]);
    this.devById = new Map(this.devices.map((d) => [d.id, d]));
    this.hideById = new Map(this.hides.map((h) => [h.id, h]));
    const N = this.w * this.h;
    this._dist = new Float32Array(N);
    this._prev = new Int32Array(N);
    this._closed = new Uint8Array(N);
    this._client = null;
  }
  inside(i, j) { return i >= 0 && j >= 0 && i < this.w && j < this.h; }
  passable(i, j) {
    if (!this.inside(i, j)) return false;
    const k = j * this.w + i;
    const t = this.tiles[k];
    return (t === T_FLOOR || t === T_DOOR) && !this.obj[k];
  }
  collide(x, y, r) {
    const rr = r || 0.3;
    const i0 = Math.floor(x - rr), i1 = Math.floor(x + rr), j0 = Math.floor(y - rr), j1 = Math.floor(y + rr);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (this.passable(i, j)) continue;
        const cx = clamp(x, i, i + 1), cy = clamp(y, j, j + 1);
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < rr * rr) return true;
      }
    }
    return false;
  }
  roomsAt(x, y) {
    const i = Math.floor(x), j = Math.floor(y);
    if (!this.inside(i, j)) return [];
    const k = j * this.w + i;
    const rid = this.roomId[k];
    if (rid >= 0) return [rid];
    if (rid === -2) return this.doorAt.get(k) || [];
    // Notfall (z. B. Rand einer Wand): nächste Bodenkachel
    for (const [di, dj] of DIRS8) {
      const ni = i + di, nj = j + dj;
      if (!this.inside(ni, nj)) continue;
      const r = this.roomId[nj * this.w + ni];
      if (r >= 0) return [r];
      if (r === -2) return this.doorAt.get(nj * this.w + ni) || [];
    }
    return [];
  }
  los(ax, ay, bx, by, r) {
    const d = dist(ax, ay, bx, by);
    const steps = Math.max(1, Math.ceil(d / 0.2));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      if (this.collide(ax + (bx - ax) * t, ay + (by - ay) * t, r || 0.31)) return false;
    }
    return true;
  }
  /* Interaktionsplätze: freie Nachbarkacheln (zuerst gerade, dann diagonal) */
  interactTiles(i, j) {
    const out = [];
    for (const [di, dj] of DIRS4) if (this.passable(i + di, j + dj)) out.push((j + dj) * this.w + (i + di));
    if (!out.length) for (const [di, dj] of DIRS8.slice(4)) if (this.passable(i + di, j + dj)) out.push((j + dj) * this.w + (i + di));
    return out;
  }
  /* A* (8 Richtungen, keine Eckenabkürzung) zu einer von mehreren Zielkacheln; liefert geglättete Wegpunkte */
  findPath(sx, sy, goals) {
    if (!goals || !goals.length) return null;
    const W = this.w;
    const si = Math.floor(sx), sj = Math.floor(sy);
    if (!this.inside(si, sj)) return null;
    const start = sj * W + si;
    const goalSet = new Set(goals);
    if (goalSet.has(start)) return [];
    const gx = goals.map((g) => g % W), gy = goals.map((g) => Math.floor(g / W));
    const hfun = (i, j) => {
      let best = Infinity;
      for (let n = 0; n < gx.length; n++) {
        const dx = Math.abs(i - gx[n]), dy = Math.abs(j - gy[n]);
        const h = Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
        if (h < best) best = h;
      }
      return best;
    };
    const distA = this._dist, prev = this._prev, closed = this._closed;
    distA.fill(Infinity); prev.fill(-1); closed.fill(0);
    const heap = new MinHeap();
    distA[start] = 0;
    heap.push(start, hfun(si, sj));
    let found = -1, guard = 0;
    while (heap.size && guard++ < 20000) {
      const u = heap.pop();
      if (closed[u]) continue;
      closed[u] = 1;
      if (goalSet.has(u)) { found = u; break; }
      const ui = u % W, uj = (u - ui) / W;
      for (let d = 0; d < 8; d++) {
        const di = DIRS8[d][0], dj = DIRS8[d][1];
        const ni = ui + di, nj = uj + dj;
        if (!this.passable(ni, nj)) continue;
        if (di && dj && (!this.passable(ui + di, uj) || !this.passable(ui, uj + dj))) continue;
        const v = nj * W + ni;
        if (closed[v]) continue;
        const nd = distA[u] + (di && dj ? 1.4142 : 1);
        if (nd < distA[v]) { distA[v] = nd; prev[v] = u; heap.push(v, nd + hfun(ni, nj)); }
      }
    }
    if (found < 0) return null;
    const tilesPath = [];
    for (let c = found; c !== start && c >= 0; c = prev[c]) tilesPath.push(c);
    tilesPath.reverse();
    const pts = tilesPath.map((c) => [(c % W) + 0.5, Math.floor(c / W) + 0.5]);
    // Glätten: so weit wie möglich mit freier Sichtlinie springen
    const out = [];
    let cx = sx, cy = sy, idx = 0;
    while (idx < pts.length) {
      let far = idx;
      for (let k = pts.length - 1; k > idx; k--) {
        if (this.los(cx, cy, pts[k][0], pts[k][1])) { far = k; break; }
      }
      out.push(pts[far]);
      cx = pts[far][0]; cy = pts[far][1];
      idx = far + 1;
    }
    return out;
  }
  toClient() {
    if (this._client) return this._client;
    this._client = {
      w: this.w, h: this.h,
      tiles: Array.from(this.tiles), roomId: Array.from(this.roomId),
      building: this.building,
      rooms: this.rooms.map((r) => ({ id: r.id, type: r.type, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, team: r.team, outdoor: !!r.outdoor })),
      doors: this.doors.map((d) => ({ x: d.x, y: d.y, a: d.a, b: d.b })),
      devices: this.devices.map((d) => ({ id: d.id, type: d.type, x: d.x, y: d.y, room: d.room, team: d.team })),
      hides: this.hides.map((h) => ({ id: h.id, type: h.type, x: h.x, y: h.y, room: h.room })),
      decor: this.decor.map((d) => ({ type: d.type, x: d.x, y: d.y })),
      exit: { x: this.exit.x, y: this.exit.y, dir: this.exit.dir }
    };
    return this._client;
  }
}

/* ---------------------------------------------------------------------
 *  RAUM-GENERATOR (BSP + Spannbaum-Türen + Inhalte + Validierung)
 * ------------------------------------------------------------------- */
const MIN_ROOM = 5;

function generateMap(building, opts) {
  const o = opts || {};
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const m = tryGenerate(building, o);
      if (m) return m;
    } catch (e) {
      console.error('[Generator] Ausnahme:', e && e.stack);
    }
  }
  if (o.teams) return generateMap(building, Object.assign({}, o, { teams: false }));
  throw new Error('Kartengenerator: keine gültige Karte gefunden');
}

function tryGenerate(building, opts) {
  const practice = building === 'uebung';
  const W = practice ? 14 : (opts.big ? 36 : 30);
  const H = practice ? 11 : (opts.big ? 26 : 22);
  const N = W * H;
  const tiles = new Uint8Array(N);
  const roomId = new Int16Array(N).fill(-1);
  const obj = new Uint8Array(N);
  const reserved = new Uint8Array(N);
  const id = (i, j) => j * W + i;

  // 1) Regionen teilen
  const leaves = [];
  if (practice) {
    leaves.push({ x0: 1, y0: 1, x1: 7, y1: H - 2, team: -1, type: 'halle' });
    leaves.push({ x0: 7, y0: 1, x1: W - 2, y1: H - 2, team: -1, type: 'kammer' });
  } else {
    const ctx = { leaves, corridors: opts.big ? 2 : 1, maxArea: opts.big ? 90 : 80, teams: !!opts.teams };
    splitRegion({ x0: 1, y0: 1, x1: W - 2, y1: H - 2, team: -1 }, 0, ctx);
  }
  const rooms = leaves.map((r, i) => ({
    id: i, x: r.x0 + 1, y: r.y0 + 1, w: r.x1 - r.x0 - 1, h: r.y1 - r.y0 - 1,
    team: r.team, corridor: !!r.corridor, reg: r, type: r.type || null, outdoor: false, name: ''
  }));
  if (rooms.some((r) => r.w < 3 || r.h < 3)) return null;

  // 2) Wände und Böden malen
  for (const r of leaves) {
    for (let i = r.x0; i <= r.x1; i++) { tiles[id(i, r.y0)] = T_WALL; tiles[id(i, r.y1)] = T_WALL; }
    for (let j = r.y0; j <= r.y1; j++) { tiles[id(r.x0, j)] = T_WALL; tiles[id(r.x1, j)] = T_WALL; }
  }
  for (const rm of rooms) {
    for (let j = rm.y; j < rm.y + rm.h; j++) for (let i = rm.x; i < rm.x + rm.w; i++) { tiles[id(i, j)] = T_FLOOR; roomId[id(i, j)] = rm.id; }
  }

  // 3) Nachbarschaften und Türen
  const edges = [];
  for (let a = 0; a < leaves.length; a++) {
    for (let b = a + 1; b < leaves.length; b++) {
      const A = leaves[a], B = leaves[b];
      if (A.x1 === B.x0 || B.x1 === A.x0) {
        const wx = A.x1 === B.x0 ? A.x1 : B.x1;
        const lo = Math.max(A.y0, B.y0) + 1, hi = Math.min(A.y1, B.y1) - 1;
        if (hi - lo + 1 >= 3) edges.push({ a, b, vert: true, wpos: wx, lo, hi });
      }
      if (A.y1 === B.y0 || B.y1 === A.y0) {
        const wy = A.y1 === B.y0 ? A.y1 : B.y1;
        const lo = Math.max(A.x0, B.x0) + 1, hi = Math.min(A.x1, B.x1) - 1;
        if (hi - lo + 1 >= 3) edges.push({ a, b, vert: false, wpos: wy, lo, hi });
      }
    }
  }
  const parent = rooms.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const doors = [];
  const usedEdge = new Set();
  const addDoor = (e) => {
    const len = e.hi - e.lo + 1;
    let width = 1, start;
    if (len >= 5 && Math.random() < 0.6) { width = 2; start = randInt(e.lo + 1, e.hi - 2); }
    else start = randInt(e.lo + 1, Math.max(e.lo + 1, e.hi - 1));
    for (let k = 0; k < width; k++) {
      const p = start + k;
      const x = e.vert ? e.wpos : p, y = e.vert ? p : e.wpos;
      tiles[id(x, y)] = T_DOOR;
      roomId[id(x, y)] = -2;
      doors.push({ x, y, a: e.a, b: e.b });
      // Platz vor und hinter der Tür freihalten
      if (e.vert) { reserved[id(x - 1, y)] = 1; reserved[id(x + 1, y)] = 1; }
      else { reserved[id(x, y - 1)] = 1; reserved[id(x, y + 1)] = 1; }
    }
  };
  shuffle(edges);
  for (const e of edges) {
    if (find(e.a) !== find(e.b)) { parent[find(e.a)] = find(e.b); addDoor(e); usedEdge.add(e); }
  }
  const comp = find(0);
  if (rooms.some((r) => find(r.id) !== comp)) return null;
  for (const e of edges) {
    if (usedEdge.has(e)) continue;
    const corr = rooms[e.a].corridor || rooms[e.b].corridor;
    if (Math.random() < (corr ? 0.7 : 0.35)) { addDoor(e); usedEdge.add(e); }
  }
  if (opts.teams) {
    const cross = () => [...usedEdge].filter((e) => rooms[e.a].team !== rooms[e.b].team).length;
    const crossFree = edges.filter((e) => !usedEdge.has(e) && rooms[e.a].team !== rooms[e.b].team);
    while (cross() < 2 && crossFree.length) { const e = crossFree.pop(); addDoor(e); usedEdge.add(e); }
  }

  // 4) Raumtypen verteilen
  const bdef = BUILDINGS[building];
  const content = ROOM_CONTENT[building];
  const touchesOuter = (r) => r.reg.x0 === 1 || r.reg.y0 === 1 || r.reg.x1 === W - 2 || r.reg.y1 === H - 2;
  if (!practice) {
    for (const r of rooms) if (r.corridor) r.type = 'flur';
    const normal = shuffle(rooms.filter((r) => !r.corridor));
    let entCands = normal.filter((r) => touchesOuter(r) && r.w >= 3 && r.h >= 3);
    if (opts.teams) {
      const t0 = entCands.filter((r) => r.team === 0);
      if (t0.length) entCands = t0;
    }
    if (!entCands.length) return null;
    entCands.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    const entrance = entCands[randInt(0, Math.min(2, entCands.length - 1))];
    entrance.type = 'eingang';
    const groups = opts.teams ? [0, 1] : [-1];
    const used = new Set(['eingang']);
    for (const g of groups) {
      for (const t of REQUIRED_ROOMS[building]) {
        const free = normal.filter((r) => !r.type && (g === -1 || r.team === g));
        if (!free.length) break;
        const r = pick(free);
        r.type = t; used.add(t);
      }
    }
    const pool = shuffle(Object.keys(bdef.rooms).filter((t) => t !== 'eingang' && t !== 'flur' && !used.has(t)));
    const repeatables = shuffle(Object.keys(content).filter((t) => content[t].repeat));
    let rep = 0;
    for (const r of normal) {
      if (r.type) continue;
      if (pool.length) r.type = pool.pop();
      else if (repeatables.length) r.type = repeatables[rep++ % repeatables.length];
      else r.type = 'flur';
    }
  }
  // Wasserbecken-Räume (Pool) bekommen einen möglichst großen Raum
  for (const r of rooms) {
    if (!(content[r.type] && content[r.type].water) || Math.min(r.w, r.h) >= 6) continue;
    const big = rooms.filter((x) => x !== r && !x.corridor && x.type !== 'eingang' && Math.min(x.w, x.h) >= 6 && x.team === r.team &&
      !(REQUIRED_ROOMS[building] || []).includes(x.type)).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (big) { const t = big.type; big.type = r.type; r.type = t; }
  }
  const nameCount = {};
  for (const r of rooms) {
    const def = bdef.rooms[r.type];
    r.outdoor = !!def.outdoor;
    nameCount[r.type] = (nameCount[r.type] || 0) + 1;
    r.name = def.name + (nameCount[r.type] > 1 ? ' ' + nameCount[r.type] : '');
  }

  // 5) Ausgang in der Außenwand des Eingangs
  let exit;
  {
    const ent = rooms.find((r) => r.type === (practice ? 'halle' : 'eingang'));
    const r = ent.reg;
    const sides = [];
    if (practice) sides.push('w');
    else {
      if (r.y0 === 1 && ent.w >= 3) sides.push('n');
      if (r.y1 === H - 2 && ent.w >= 3) sides.push('s');
      if (r.x0 === 1 && ent.h >= 3) sides.push('w');
      if (r.x1 === W - 2 && ent.h >= 3) sides.push('e');
    }
    if (!sides.length) return null;
    const dir = pick(sides);
    let ex, ey, fx, fy;
    if (dir === 'n' || dir === 's') {
      ex = randInt(ent.x + 1, ent.x + ent.w - 2);
      ey = dir === 'n' ? r.y0 : r.y1;
      fx = ex; fy = dir === 'n' ? ey + 1 : ey - 1;
    } else {
      ey = randInt(ent.y + 1, ent.y + ent.h - 2);
      ex = dir === 'w' ? r.x0 : r.x1;
      fy = ey; fx = dir === 'w' ? ex + 1 : ex - 1;
    }
    if (tiles[id(ex, ey)] !== T_WALL) return null;
    tiles[id(ex, ey)] = T_EXIT;
    reserved[id(fx, fy)] = 1;
    exit = { x: ex, y: ey, dir, fx, fy };
  }

  // 6) Inhalte platzieren
  const devices = [], hides = [], decor = [];
  let devN = 0, hideN = 0;
  const isFree = (i, j) => tiles[id(i, j)] === T_FLOOR && !obj[id(i, j)] && !reserved[id(i, j)];
  const adjWall = (i, j) => DIRS4.some(([di, dj]) => tiles[id(i + di, j + dj)] === T_WALL);
  const adjObj4 = (i, j) => DIRS4.some(([di, dj]) => obj[id(i + di, j + dj)]);
  const near8Bad = (i, j) => DIRS8.some(([di, dj]) => obj[id(i + di, j + dj)] || reserved[id(i + di, j + dj)]);
  const roomOk = (rm) => {
    // alle freien Böden des Raums zusammenhängend + jedes Objekt hat freien Nachbarn
    let start = -1, total = 0;
    for (let j = rm.y; j < rm.y + rm.h; j++) for (let i = rm.x; i < rm.x + rm.w; i++) {
      if (!obj[id(i, j)]) { total++; if (start < 0) start = id(i, j); }
    }
    if (start < 0) return false;
    const seen = new Uint8Array(N);
    const q = [start]; seen[start] = 1; let cnt = 0;
    while (q.length) {
      const c = q.pop(); cnt++;
      const ci = c % W, cj = (c - ci) / W;
      for (const [di, dj] of DIRS4) {
        const ni = ci + di, nj = cj + dj;
        if (ni < rm.x || nj < rm.y || ni >= rm.x + rm.w || nj >= rm.y + rm.h) continue;
        const k = id(ni, nj);
        if (seen[k] || obj[k]) continue;
        seen[k] = 1; q.push(k);
      }
    }
    if (cnt !== total) return false;
    for (let j = rm.y; j < rm.y + rm.h; j++) for (let i = rm.x; i < rm.x + rm.w; i++) {
      if (!obj[id(i, j)]) continue;
      if (!DIRS4.some(([di, dj]) => seen[id(i + di, j + dj)])) return false;
    }
    return true;
  };
  const wallCands = (rm) => {
    const out = [];
    for (let j = rm.y; j < rm.y + rm.h; j++) for (let i = rm.x; i < rm.x + rm.w; i++) {
      if (isFree(i, j) && adjWall(i, j) && !adjObj4(i, j)) out.push([i, j]);
    }
    return shuffle(out);
  };
  const centerCands = (rm) => {
    const out = [];
    for (let j = rm.y + 2; j <= rm.y + rm.h - 3; j++) for (let i = rm.x + 2; i <= rm.x + rm.w - 3; i++) {
      if (isFree(i, j) && !near8Bad(i, j)) out.push([i, j]);
    }
    return shuffle(out);
  };
  const tryPlace = (rm, cands) => {
    for (const [i, j] of cands) {
      if (!isFree(i, j)) continue;
      obj[id(i, j)] = 1;
      if (roomOk(rm)) return [i, j];
      obj[id(i, j)] = 0;
    }
    return null;
  };
  const placeDevice = (rm, type) => {
    if (DEVICE_TYPES[type].mobile) {
      if (devices.filter((d) => d.type === type).length >= (opts.big ? 2 : 1)) return false;
      const cands = [];
      for (let j = rm.y; j < rm.y + rm.h; j++) for (let i = rm.x; i < rm.x + rm.w; i++) if (isFree(i, j)) cands.push([i, j]);
      if (!cands.length) return false;
      const [i, j] = pick(cands);
      devices.push({ id: 'd' + (++devN), type, x: i, y: j, room: rm.id, team: rm.team });
      return true;
    }
    const p = tryPlace(rm, wallCands(rm));
    if (!p) return false;
    devices.push({ id: 'd' + (++devN), type, x: p[0], y: p[1], room: rm.id, team: rm.team });
    return true;
  };
  const placeHide = (rm, type, center) => {
    const p = tryPlace(rm, center ? centerCands(rm).concat(wallCands(rm)) : wallCands(rm));
    if (!p) return false;
    hides.push({ id: 'h' + (++hideN), type, x: p[0], y: p[1], room: rm.id });
    return true;
  };
  const placeDecor = (rm, type, center) => {
    const p = tryPlace(rm, center ? centerCands(rm) : wallCands(rm));
    if (!p) return false;
    decor.push({ type, x: p[0], y: p[1] });
    return true;
  };

  for (const rm of rooms) {
    const c = content[rm.type] || {};
    if (c.water) {
      for (let j = rm.y + 2; j <= rm.y + rm.h - 3; j++) for (let i = rm.x + 2; i <= rm.x + rm.w - 3; i++) {
        if (reserved[id(i, j)]) continue;
        obj[id(i, j)] = 1; decor.push({ type: 'wasser', x: i, y: j });
      }
      if (!roomOk(rm)) return null;
    }
    for (const t of c.dev || []) if (!placeDevice(rm, t) && NEED_DEVICE_TYPES.includes(t) && practice) return null;
    for (const t of c.hide || []) placeHide(rm, t, false);
    for (const t of c.hideC || []) placeHide(rm, t, true);
    for (const t of c.decorC || []) placeDecor(rm, t, true);
    for (const t of c.decor || []) placeDecor(rm, t, false);
    if (!practice && rm.w * rm.h >= 48 && !c.water) placeDecor(rm, rm.outdoor ? 'pflanze' : pick(['pflanze', 'lampe', 'regal']), false);
  }

  // 7) Pflichtgeräte sicherstellen (Kaffee/WC/Snack, im Team-Modus je Trakt)
  if (!practice) {
    const groups = opts.teams ? [0, 1] : [-1];
    const need = opts.big && !opts.teams ? 2 : 1;
    for (const g of groups) {
      for (const t of NEED_DEVICE_TYPES) {
        let have = devices.filter((d) => d.type === t && (g === -1 || rooms[d.room].team === g)).length;
        if (have >= need) continue;
        const cand = rooms.filter((r) => (g === -1 || r.team === g) && !r.outdoor)
          .sort((a, b) => devices.filter((d) => d.room === a.id).length - devices.filter((d) => d.room === b.id).length);
        for (const rm of cand) {
          if (have >= need) break;
          if (placeDevice(rm, t)) have++;
        }
        if (have < need) return null;
      }
    }
  }

  // 8) Globale Validierung: alles erreichbar
  const passable = (k) => (tiles[k] === T_FLOOR || tiles[k] === T_DOOR) && !obj[k];
  const startK = id(exit.fx, exit.fy);
  if (!passable(startK)) return null;
  const seen = new Uint8Array(N);
  const q = [startK]; seen[startK] = 1;
  while (q.length) {
    const c = q.pop();
    const ci = c % W, cj = (c - ci) / W;
    for (const [di, dj] of DIRS4) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const k = id(ni, nj);
      if (seen[k] || !passable(k)) continue;
      seen[k] = 1; q.push(k);
    }
  }
  for (let k = 0; k < N; k++) if (passable(k) && !seen[k]) return null;
  const hasReach = (i, j) => DIRS4.some(([di, dj]) => seen[id(i + di, j + dj)]);
  for (const d of devices) {
    if (DEVICE_TYPES[d.type].mobile) { if (!seen[id(d.x, d.y)]) return null; }
    else if (!hasReach(d.x, d.y)) return null;
  }
  for (const h of hides) if (!hasReach(h.x, h.y)) return null;
  for (const d of doors) {
    // Tür muss auf beiden Seiten frei sein
    if (!seen[id(d.x, d.y)]) return null;
  }
  for (const r of rooms) delete r.reg;

  return new GameMap({
    w: W, h: H, tiles, roomId, obj, building,
    rooms: rooms.map((r) => ({ id: r.id, type: r.type, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, team: r.team, outdoor: r.outdoor, corridor: r.corridor })),
    doors, devices, hides, decor,
    exit: { x: exit.x, y: exit.y, dir: exit.dir, fx: exit.fx, fy: exit.fy }
  });
}

function splitRegion(r, depth, ctx) {
  const iw = r.x1 - r.x0 - 1, ih = r.y1 - r.y0 - 1;
  if (ctx.teams && depth === 0) {
    const s = Math.floor((r.x0 + r.x1) / 2);
    splitRegion({ x0: r.x0, y0: r.y0, x1: s, y1: r.y1, team: 0 }, 1, ctx);
    splitRegion({ x0: s, y0: r.y0, x1: r.x1, y1: r.y1, team: 1 }, 1, ctx);
    return;
  }
  const canV = iw >= 2 * MIN_ROOM + 1, canH = ih >= 2 * MIN_ROOM + 1;
  const area = iw * ih;
  const must = iw > 13 || ih > 10 || area > ctx.maxArea;
  const want = must || (area > 40 && depth < 4 && Math.random() < 0.3);
  if ((!canV && !canH) || !want) { ctx.leaves.push(r); return; }
  let vert;
  if (canV && !canH) vert = true;
  else if (!canV && canH) vert = false;
  else if (iw > ih * 1.2) vert = true;
  else if (ih > iw * 1.2) vert = false;
  else vert = Math.random() < 0.5;
  const lo = vert ? r.x0 : r.y0, hi = vert ? r.x1 : r.y1;
  const span = hi - lo - 1;
  const mk = (a, b, extra) => (vert
    ? Object.assign({ x0: a, y0: r.y0, x1: b, y1: r.y1, team: r.team }, extra || {})
    : Object.assign({ x0: r.x0, y0: a, x1: r.x1, y1: b, team: r.team }, extra || {}));
  if (ctx.corridors > 0 && depth <= 2 && span >= 2 * MIN_ROOM + 5 && Math.random() < 0.5) {
    const a = lo + MIN_ROOM + 1, b = hi - MIN_ROOM - 5;
    if (a <= b) {
      ctx.corridors--;
      const s1 = randInt(a, b), s2 = s1 + 4;
      splitRegion(mk(lo, s1), depth + 1, ctx);
      ctx.leaves.push(mk(s1, s2, { corridor: true }));
      splitRegion(mk(s2, hi), depth + 1, ctx);
      return;
    }
  }
  const a = lo + MIN_ROOM + 1, b = hi - MIN_ROOM - 1;
  const s = Math.round(a + (b - a) * ((Math.random() + Math.random()) / 2));
  splitRegion(mk(lo, s), depth + 1, ctx);
  splitRegion(mk(s, hi), depth + 1, ctx);
}

/* ---------------------------------------------------------------------
 *  SPIEL-SIMULATION (serverautoritativ)
 * ------------------------------------------------------------------- */
const BASE_SPEED = 3.2;
const NPC_SPEED = 2.2;
const ROBOT_SPEED = 1.2;
const USE_RANGE = 1.5;
const HIDE_RANGE = 1.4;
const ENT_R = 0.3;
const NEED_MAX = 25;
const NEED_KEYS = Object.keys(NEED_DEFS);

function trapForSlot(devType, slot) {
  if (slot === 8) return 'x_supernova';
  if (slot === 9) return 'x_tsunami';
  const fam = FAMILIES[DEVICE_TYPES[devType].family];
  return fam.traps[slot - 1];
}

class Game {
  constructor(room, opts) {
    this.room = room;
    this.practice = !!opts.practice;
    this.settings = Object.assign({}, room.settings);
    this.mode = this.practice ? 'uebung' : this.settings.mode;
    this.building = this.practice ? 'uebung' : this.settings.building;
    this.teams = this.mode === 'teams';
    this.items = !this.practice && this.settings.trapRule === 'items';
    this.party = !!this.settings.party;
    this.duration = this.practice ? null : (this.mode === 'chaos' ? (this.settings.duration === 5 ? 300 : 180) : MODE_DURATION[this.mode]);
    if (ROUND_OVERRIDE && !this.practice) this.duration = ROUND_OVERRIDE;
    const participants = (opts.participants || []).filter((m) => !m.spectator);
    this.map = generateMap(this.building, { big: participants.length >= 4, teams: this.teams });
    this.bdef = BUILDINGS[this.building];
    this.time = 0;
    this.elapsed = 0;
    this.freezeT = this.practice ? 0 : 3.2;
    this.lastCount = 4;
    this.started = this.practice;
    this.over = false;
    this.tick = 0;
    this.players = new Map();
    this.npcs = [];
    this.robots = [];
    this.pickups = [];
    this.pickupN = 0;
    this.pickupRespawn = [];
    this.teamScores = [0, 0];
    this.out = new Map();
    this.devState = new Map();
    for (const d of this.map.devices) this.devState.set(d.id, { trap: null, treasure: null });
    // Freie Kacheln je Raum
    this.roomTiles = this.map.rooms.map(() => []);
    for (let j = 0; j < this.map.h; j++) {
      for (let i = 0; i < this.map.w; i++) {
        const k = j * this.map.w + i;
        const r = this.map.roomId[k];
        if (r >= 0 && this.map.passable(i, j)) this.roomTiles[r].push(k);
      }
    }
    this.exitPos = { x: this.map.exit.x + 0.5, y: this.map.exit.y + 0.5 };
    this.availableTasks = this.bdef.tasks.filter((t) => this.map.devices.some((d) => d.type === t.type));
    // Teilnehmer
    const usedRooms = new Set();
    for (const m of participants) this.addPlayer(m, usedRooms);
    // NPCs
    const npcCount = this.practice ? 1 : 3 + Math.floor(participants.length / 2);
    for (let k = 0; k < npcCount; k++) this.addNpc(this.bdef.npcs[k % this.bdef.npcs.length]);
    // Saugroboter
    for (const d of this.map.devices) {
      if (DEVICE_TYPES[d.type].mobile) this.robots.push({ id: d.id, kind: 'r', dev: d, x: d.x + 0.5, y: d.y + 0.5, d: 0, mv: 0, path: null, waitT: rand(0, 2), room: d.room, stuckT: 0 });
    }
    // Schätze
    if (this.mode === 'schatzsuche') {
      const cands = shuffle(this.map.devices.filter((d) => !DEVICE_TYPES[d.type].mobile));
      Object.keys(TREASURES).forEach((t, i) => { if (cands[i]) this.devState.get(cands[i].id).treasure = t; });
    }
    // Sammel-Items
    if (this.items) for (let k = 0; k < 5; k++) this.spawnPickup();
  }

  /* ---------- Aufbau ---------- */
  randomTile(filterRoom) {
    const rooms = this.map.rooms.filter((r) => this.roomTiles[r.id].length && (!filterRoom || filterRoom(r)));
    if (!rooms.length) return null;
    const r = pick(rooms);
    const k = pick(this.roomTiles[r.id]);
    return { x: (k % this.map.w) + 0.5, y: Math.floor(k / this.map.w) + 0.5, room: r.id };
  }
  addPlayer(m, usedRooms) {
    const rec = m.profileKey ? DB.players[m.profileKey] : null;
    const team = this.teams ? (m.team === 1 ? 1 : 0) : -1;
    let spot = null;
    const used = usedRooms || new Set();
    for (let tries = 0; tries < 30 && !spot; tries++) {
      const s = this.randomTile((r) => (!this.teams || r.team === team) && (tries > 15 || !used.has(r.id)));
      if (s) spot = s;
    }
    if (!spot) spot = this.randomTile(null) || { x: this.map.exit.fx + 0.5, y: this.map.exit.fy + 0.5, room: 0 };
    used.add(spot.room);
    const p = {
      id: m.id, kind: 'p', name: m.name, avatar: m.avatar, team, bot: !!m.bot, ai: !!(m.bot || m.ai), profileKey: m.profileKey || null,
      slots: m.bot ? 5 : (rec ? rec.slots : 3), master: m.bot ? false : !!(rec && rec.master), perk: rec ? rec.perk : null,
      x: spot.x, y: spot.y, d: Math.PI / 4, mv: 0, input: { x: 0, y: 0 }, path: null, pathThen: null, pathStuck: 0, pathGoals: null,
      st: '', stunT: 0, stunTotal: 0, fx: null, knock: null,
      need: null, needT: 0, needCd: this.practice ? rand(8, 12) : rand(15, 25), slow: false, boostT: 0, adrT: 0, radarT: 0,
      build: null, use: null, hidden: null, dgT: 0, dgCd: 0, waveCd: 0,
      tasks: [], treasures: [], held: [], exitOpen: false, score: 0, chaos: 0, comboN: 0, comboT: -99, badLuck: 0,
      emo: null, emoT: 0, noticeT: 0, dailyDone: [],
      brain: { thinkT: rand(0.5, 1.5), known: new Set(), buildCd: rand(5, 10), hideT: 0, searched: new Map(), lastX: spot.x, lastY: spot.y, stillT: 0 }
    };
    if (this.mode === 'checkliste') {
      p.tasks = shuffle(this.availableTasks.slice()).slice(0, 4).map((t) => ({ id: t.id, label: t.label, icon: t.icon, type: t.type, done: false }));
    }
    this.players.set(p.id, p);
    return p;
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
  }
  addNpc(type) {
    const s = this.randomTile(null);
    if (!s) return;
    this.npcs.push({
      id: 'n' + (this.npcs.length + 1), kind: 'n', npc: type, x: s.x, y: s.y, d: 0, mv: 0, path: null, pathStuck: 0,
      st: '', waitT: rand(0.5, 3), useT: 0, useDev: null, stunT: 0, fx: null, knock: null, lure: false, alarmT: 0, emo: null, emoT: 0
    });
  }
  spawnPickup() {
    const s = this.randomTile((r) => true);
    if (!s) return;
    const k = Math.floor(s.y) * this.map.w + Math.floor(s.x);
    if (this.map.roomId[k] < 0) return;
    this.pickups.push({ id: 'i' + (++this.pickupN), item: pick(Object.keys(ITEMS)), x: s.x, y: s.y });
  }

  /* ---------- Hilfen ---------- */
  devPos(dev) {
    if (DEVICE_TYPES[dev.type].mobile) {
      const r = this.robots.find((x) => x.id === dev.id);
      if (r) return { x: r.x, y: r.y };
    }
    return { x: dev.x + 0.5, y: dev.y + 0.5 };
  }
  roomsOf(e) {
    if (e._rt !== this.tick) { e._rooms = this.map.roomsAt(e.x, e.y); e._rt = this.tick; }
    return e._rooms;
  }
  sameRooms(a, b) {
    const ra = this.roomsOf(a), rb = this.roomsOf(b);
    for (const x of ra) if (rb.includes(x)) return true;
    return false;
  }
  canSeePos(v, x, y) {
    const ra = this.roomsOf(v), rb = this.map.roomsAt(x, y);
    for (const r of ra) if (rb.includes(r)) return true;
    return false;
  }
  canSeeEnt(v, q) {
    if (v === q) return true;
    if (q.kind === 'p' && q.hidden) return false;
    if (this.teams && q.kind === 'p' && v.team === q.team) return true;
    return this.sameRooms(v, q);
  }
  isTeammate(a, b) { return this.teams && a && b && a.team === b.team; }
  idFor(viewer, q) {
    if (q.kind === 'p' && q.dgT > 0 && viewer && viewer !== q && !this.isTeammate(viewer, q)) return 'v' + q.id;
    return q.id;
  }
  speedOf(p) {
    let s = BASE_SPEED;
    if (p.boostT > 0) s *= 1.45;
    if (p.slow) s *= 0.7;
    if (p.adrT > 0 && p.stunT <= 0) s *= 1.6;
    if (p.ai) s *= 0.9; // KI trödelt ein bisschen – faire Chance für Menschen
    return Math.min(s, BASE_SPEED * 2.2);
  }
  nearestDevice(p, range) {
    let best = null, bd = range;
    for (const d of this.map.devices) {
      const pos = this.devPos(d);
      const dd = dist(p.x, p.y, pos.x, pos.y);
      if (dd <= bd) { bd = dd; best = d; }
    }
    return best;
  }
  nearestHide(p) {
    let best = null, bd = HIDE_RANGE;
    for (const h of this.map.hides) {
      if (this.hideOccupant(h.id) && this.hideOccupant(h.id) !== p) continue;
      const dd = dist(p.x, p.y, h.x + 0.5, h.y + 0.5);
      if (dd <= bd) { bd = dd; best = h; }
    }
    return best;
  }
  hideOccupant(hid) {
    for (const p of this.players.values()) if (p.hidden === hid) return p;
    return null;
  }
  slotUnlocked(p, slot) {
    if (slot <= 3) return true;
    if (this.party) return true;
    if (slot <= 7) return (p.slots || 3) >= slot;
    return !!p.master;
  }
  wheelSize(p) { return (this.party || p.master) ? 9 : 7; }
  npcName(type) { return (NPC_TYPES[type] || { name: 'NPC' }).name; }
  entName(e) { return e.kind === 'p' ? e.name : this.npcName(e.npc); }

  /* ---------- Ereignis-Versand ---------- */
  queueSocket(sid, ev) {
    let arr = this.out.get(sid);
    if (!arr) { arr = []; this.out.set(sid, arr); }
    arr.push(ev);
  }
  queue(pid, ev) {
    const m = this.room.members.get(pid);
    if (m && m.socketId) this.queueSocket(m.socketId, ev);
  }
  queueAll(ev) {
    for (const m of this.room.members.values()) if (m.socketId) this.queueSocket(m.socketId, ev);
  }
  /* an alle, die Position (x,y) sehen; evf(viewer) darf Event pro Empfänger bauen */
  queueViewers(x, y, evf, alsoIds) {
    const extra = new Set(alsoIds || []);
    for (const m of this.room.members.values()) {
      if (!m.socketId) continue;
      const v = this.players.get(m.id);
      if (!v || m.spectator || extra.has(m.id) || this.canSeePos(v, x, y)) {
        const ev = typeof evf === 'function' ? evf(v || null) : evf;
        if (ev) this.queueSocket(m.socketId, ev);
      }
    }
  }
  toast(pid, msg, kind) { this.queue(pid, { e: 'toast', msg, kind: kind || 'info' }); }
  stat(p, name, n) {
    if (this.practice || !p || !p.profileKey || p.bot) return;
    const rec = DB.players[p.profileKey];
    if (!rec) return;
    const done = bumpStat(rec, name, n || 1);
    if (done.length) {
      p.dailyDone.push(...done);
      for (const t of done) this.toast(p.id, `🏅 Tagesziel geschafft: ${t} (+60 Münzen, +80 XP)`, 'good');
      this.room.pushProfile(p.id);
    }
  }

  /* ---------- Hauptschleife ---------- */
  step(dt) {
    if (this.over) return;
    this.tick++;
    this.time += dt;
    if (this.freezeT > 0) {
      this.freezeT -= dt;
      const n = Math.ceil(this.freezeT);
      if (n < this.lastCount && n >= 1) { this.lastCount = n; this.queueAll({ e: 'countdown', n }); }
      if (this.freezeT <= 0) {
        this.started = true;
        this.queueAll({ e: 'start', mode: this.mode });
        this.queueAll({ e: 'say', text: 'Los geht\'s!' });
      }
      return;
    }
    this.elapsed += dt;
    for (const p of this.players.values()) this.updateTimers(p, dt);
    for (const p of this.players.values()) if (p.ai) this.botThink(p, dt);
    for (const n of this.npcs) this.npcStep(n, dt);
    for (const p of this.players.values()) { this.movePlayer(p, dt); if (this.over) return; }
    for (const r of this.robots) this.robotStep(r, dt);
    this.checkCaught(dt);
    this.updatePickups(dt);
    if (!this.practice && this.duration && this.elapsed >= this.duration) this.endRound(null, 'time');
  }

  updateTimers(p, dt) {
    if (p.emoT > 0) { p.emoT -= dt; if (p.emoT <= 0) p.emo = null; }
    if (p.stunT > 0) {
      p.stunT -= dt;
      if (p.stunT <= 0) { p.stunT = 0; p.fx = null; p.st = ''; p.knock = null; }
    }
    if (p.boostT > 0) p.boostT = Math.max(0, p.boostT - dt);
    if (p.adrT > 0) p.adrT = Math.max(0, p.adrT - dt);
    if (p.radarT > 0) p.radarT = Math.max(0, p.radarT - dt);
    if (p.dgCd > 0) p.dgCd = Math.max(0, p.dgCd - dt);
    if (p.waveCd > 0) p.waveCd = Math.max(0, p.waveCd - dt);
    if (p.dgT > 0) {
      p.dgT -= dt;
      if (p.dgT <= 0) { p.dgT = 0; this.queue(p.id, { e: 'disguise', on: false, name: this.bdef.disguise.name }); }
    }
    if (!p.need) {
      p.needCd -= dt;
      if (p.needCd <= 0) {
        p.need = pick(NEED_KEYS); p.needT = 0; p.slow = false;
        this.queue(p.id, { e: 'need', need: p.need });
      }
    } else {
      p.needT += dt;
      if (p.needT >= NEED_MAX && !p.slow) {
        p.slow = true;
        this.queue(p.id, { e: 'needSlow', need: p.need });
      }
    }
  }

  moveEnt(e, vx, vy, dt, r) {
    const rr = r || ENT_R;
    const ox = e.x, oy = e.y;
    const nx = e.x + vx * dt;
    if (!this.map.collide(nx, e.y, rr)) e.x = nx;
    const ny = e.y + vy * dt;
    if (!this.map.collide(e.x, ny, rr)) e.y = ny;
    return Math.hypot(e.x - ox, e.y - oy);
  }
  /* folgt e.path; liefert true, wenn angekommen */
  followPath(e, spd, dt, r) {
    if (!e.path || !e.path.length) return true;
    const wp = e.path[0];
    const dx = wp[0] - e.x, dy = wp[1] - e.y;
    const dd = Math.hypot(dx, dy);
    if (dd < 0.08) {
      e.path.shift();
      return !e.path.length;
    }
    const f = Math.min(1, dd / (spd * dt));
    const vx = (dx / dd) * spd * f, vy = (dy / dd) * spd * f;
    const moved = this.moveEnt(e, vx, vy, dt, r);
    e.d = Math.atan2(dy, dx);
    e.mv = moved > 0.002 ? 1 : 0;
    if (moved < spd * dt * 0.2) e.pathStuck = (e.pathStuck || 0) + dt; else e.pathStuck = 0;
    if (e.pathStuck > 0.7) {
      // hängt fest → direkt zur nächsten Kachelmitte ausweichen bzw. Weg neu planen
      e.pathStuck = 0;
      const goal = e.path[e.path.length - 1];
      const np = this.map.findPath(e.x, e.y, [Math.floor(goal[1]) * this.map.w + Math.floor(goal[0])]);
      if (np && np.length) e.path = np; else { e.path = null; return true; }
    }
    return false;
  }

  movePlayer(p, dt) {
    if (p.stunT > 0) {
      p.mv = 0;
      if (p.knock && p.knock.t > 0) {
        this.moveEnt(p, p.knock.vx, p.knock.vy, Math.min(dt, p.knock.t));
        p.knock.t -= dt;
      }
      return;
    }
    if (p.hidden) { p.mv = 0; return; }
    if (p.build) {
      p.mv = 0;
      const dev = this.map.devById.get(p.build.dev);
      const pos = this.devPos(dev);
      if (dist(p.x, p.y, pos.x, pos.y) > USE_RANGE + 0.5) { this.cancelAction(p, 'Zu weit weg – Falle abgebrochen.'); return; }
      p.build.t += dt;
      if (p.build.t >= p.build.total) this.finishBuild(p);
      return;
    }
    if (p.use) {
      p.mv = 0;
      p.use.t += dt;
      if (p.use.t >= p.use.total) this.finishUse(p);
      return;
    }
    const spd = this.speedOf(p);
    const il = Math.hypot(p.input.x, p.input.y);
    if (il > 0.05) {
      p.path = null; p.pathThen = null;
      const k = Math.min(1, il);
      const vx = (p.input.x / il) * k * spd, vy = (p.input.y / il) * k * spd;
      const moved = this.moveEnt(p, vx, vy, dt);
      p.mv = moved > 0.002 ? 1 : 0;
      p.d = Math.atan2(vy, vx);
    } else if (p.path) {
      const arrived = this.followPath(p, spd, dt);
      if (arrived) {
        p.path = null; p.mv = 0;
        const then = p.pathThen; p.pathThen = null;
        if (then) this.onArrive(p, then);
      }
    } else p.mv = 0;
    // Pickups beim Drüberlaufen
    if (this.items && p.held.length < 3) {
      for (const it of this.pickups) {
        if (dist(p.x, p.y, it.x, it.y) < 0.6) { this.takePickup(p, it); break; }
      }
    }
    // Ausgang erreicht?
    if (p.exitOpen && !this.over && dist(p.x, p.y, this.exitPos.x, this.exitPos.y) < 1.0) this.win(p);
  }

  onArrive(p, then) {
    if (then === 'use') return this.doUse(p);
    if (then === 'hide') return this.doHide(p);
    if (typeof then === 'object' && then) {
      const dev = then.dev ? this.map.devById.get(then.dev) : null;
      if (then.act === 'use' && dev) {
        const pos = this.devPos(dev);
        if (dist(p.x, p.y, pos.x, pos.y) <= USE_RANGE + 0.15) this.useDevice(p, dev); else this.doUse(p);
      } else if (then.act === 'trap' && dev) {
        if (p.ai) {
          // Bots bauen nicht vor Zeugen – notfalls erst verkleiden
          const w = this.botWatched(p);
          if (w.player) return;
          if (w.npc && p.dgT <= 0) { if (p.dgCd <= 0) this.doDisguise(p); else return; }
        }
        this.actTrap(p, dev.id, then.slot);
      }
      else if (then.act === 'hide') this.doHide(p);
      else if (then.act === 'exit') this.doUse(p);
    }
  }

  cancelAction(p, msg) {
    if (!p.build && !p.use) return;
    p.build = null; p.use = null; p.st = ''; p.noticeT = 0;
    if (msg && !p.bot) this.toast(p.id, msg, 'info');
  }

  /* ---------- Benutzen ---------- */
  doUse(p) {
    if (this.freezeT > 0 || p.stunT > 0 || p.build || p.use) return;
    if (p.hidden) { this.doHide(p); return; }
    const de = dist(p.x, p.y, this.exitPos.x, this.exitPos.y);
    if (p.exitOpen && de < 1.6) { this.win(p); return; }
    if (this.items) {
      let best = null, bd = 1.0;
      for (const it of this.pickups) { const d = dist(p.x, p.y, it.x, it.y); if (d < bd) { bd = d; best = it; } }
      if (best) { this.takePickup(p, best); return; }
    }
    const dev = this.nearestDevice(p, USE_RANGE);
    if (!dev) {
      if (de < 1.6 && !this.practice && (this.mode === 'checkliste' || this.mode === 'schatzsuche')) {
        this.toast(p.id, this.mode === 'checkliste' ? '🔒 Der Ausgang ist noch zu – erledige erst alle Aufgaben!' : '🔒 Der Ausgang ist noch zu – du brauchst alle 3 Schätze!', 'bad');
      } else this.toast(p.id, 'Hier gibt es nichts zu benutzen.', 'info');
      return;
    }
    this.useDevice(p, dev);
  }
  useDevice(p, dev) {
    if (p.stunT > 0 || p.build || p.use || p.hidden) return;
    const t = DEVICE_TYPES[dev.type];
    const st = this.devState.get(dev.id);
    if (t.mobile) {
      if (st.trap) { this.triggerTrap(dev, p); return; }
      this.toast(p.id, '🤖 Der Saugroboter piept fröhlich – benutzen kann man ihn nicht, aber sabotieren!', 'info');
      return;
    }
    p.path = null; p.pathThen = null;
    const pos = this.devPos(dev);
    p.d = Math.atan2(pos.y - p.y, pos.x - p.x);
    if (st.trap) { this.triggerTrap(dev, p); return; }
    const purposes = {};
    let total = 1.0;
    if (p.need && NEED_DEFS[p.need].types.includes(dev.type)) { purposes.need = true; total = Math.max(total, 1.2); }
    if (this.mode === 'checkliste') {
      const task = p.tasks.find((x) => !x.done && x.type === dev.type);
      if (task) { purposes.task = task.id; total = Math.max(total, 1.5); }
    }
    if (this.mode === 'schatzsuche') purposes.search = true;
    p.use = { dev: dev.id, t: 0, total, purposes };
    p.st = purposes.search && !purposes.need ? 'search' : 'use';
  }
  finishUse(p) {
    const u = p.use;
    p.use = null; p.st = '';
    const dev = this.map.devById.get(u.dev);
    let did = false;
    if (u.purposes.need && p.need) { this.fulfillNeed(p); did = true; }
    if (u.purposes.task) {
      const task = p.tasks.find((x) => x.id === u.purposes.task);
      if (task && !task.done) {
        task.done = true; did = true;
        const left = p.tasks.filter((x) => !x.done).length;
        p.score += 30;
        this.queue(p.id, { e: 'task', label: task.label, icon: task.icon, left });
        if (!left) {
          p.exitOpen = true;
          this.queue(p.id, { e: 'allTasks' });
          this.toast(p.id, '🚪 Alle Aufgaben erledigt – ab zum Ausgang!', 'good');
        }
      }
    }
    if (u.purposes.search) {
      did = true;
      const st = this.devState.get(dev.id);
      p.brain.searched.set(dev.id, this.time);
      if (st.treasure && !p.treasures.includes(st.treasure)) {
        const t = st.treasure; st.treasure = null;
        p.treasures.push(t);
        p.score += 50;
        this.queue(p.id, { e: 'search', found: t });
        this.queue(p.id, { e: 'treasure', id: t, name: TREASURES[t].name });
        if (p.treasures.length >= 3) {
          p.exitOpen = true;
          this.queue(p.id, { e: 'allTreasures' });
          this.toast(p.id, '🚪 Alle 3 Schätze! Schnell zum Ausgang!', 'good');
        }
      } else this.queue(p.id, { e: 'search', found: null });
    }
    if (!did) this.toast(p.id, `${DEVICE_TYPES[dev.type].icon} Gerade kein Bedarf.`, 'info');
    // kurze Verschnaufpause der KI (nach einer erledigten Aufgabe etwas länger – Kaffeeklatsch!)
    if (p.ai) p.brain.thinkT = u.purposes.task ? rand(4, 9) : rand(0.8, 2.2);
  }
  fulfillNeed(p) {
    const n = p.need;
    p.need = null; p.needT = 0; p.slow = false;
    p.boostT = 5; p.needCd = rand(20, 40);
    p.score += 10;
    this.queue(p.id, { e: 'needDone', need: n, boost: 5 });
    this.stat(p, 'needs', 1);
  }
  takePickup(p, it) {
    if (p.held.length >= 3) { this.toast(p.id, 'Deine Taschen sind voll (max. 3 Sammel-Items).', 'info'); return; }
    const i = this.pickups.indexOf(it);
    if (i < 0) return;
    this.pickups.splice(i, 1);
    p.held.push(it.item);
    this.pickupRespawn.push(20);
    this.queue(p.id, { e: 'pickup', item: it.item });
  }
  updatePickups(dt) {
    if (!this.items) return;
    for (let i = this.pickupRespawn.length - 1; i >= 0; i--) {
      this.pickupRespawn[i] -= dt;
      if (this.pickupRespawn[i] <= 0) { this.pickupRespawn.splice(i, 1); this.spawnPickup(); }
    }
  }

  /* ---------- Fallen ---------- */
  wheelOptions(p, devId) {
    if (p.stunT > 0) return { ok: false, msg: 'Du bist gerade außer Gefecht!' };
    if (p.hidden) return { ok: false, msg: 'Erst aus dem Versteck kommen!' };
    if (this.freezeT > 0) return { ok: false, msg: 'Gleich geht\'s los …' };
    let dev = devId ? this.map.devById.get(devId) : null;
    if (dev) { const pos = this.devPos(dev); if (dist(p.x, p.y, pos.x, pos.y) > USE_RANGE + 0.3) dev = null; }
    if (!dev) dev = this.nearestDevice(p, USE_RANGE);
    if (!dev) return { ok: false, msg: 'Kein Gerät in der Nähe.' };
    const t = DEVICE_TYPES[dev.type];
    const size = this.wheelSize(p);
    const options = [];
    for (let slot = 1; slot <= size; slot++) {
      const id = trapForSlot(dev.type, slot);
      const tr = TRAPS[id];
      const tier = slotTier(slot);
      const locked = !this.slotUnlocked(p, slot);
      const o = {
        slot, id, name: tr.name, icon: tr.icon, fx: tr.fx, tier, item: tr.item,
        time: r2(TIERS[tier].build * (p.perk === 'flink' ? 0.75 : 1)), locked,
        boost: this.items && p.held.includes(tr.item)
      };
      if (locked) o.price = slot <= 7 ? SHOP['slot' + slot].price : SHOP.master.price;
      options.push(o);
    }
    return { ok: true, dev: { id: dev.id, type: dev.type, name: t.name, icon: t.icon }, options };
  }
  actTrap(p, devId, slot) {
    if (this.freezeT > 0 || p.stunT > 0 || p.build || p.use) return;
    if (p.hidden) { this.queue(p.id, { e: 'buildFail', msg: 'Erst aus dem Versteck kommen!' }); return; }
    const dev = this.map.devById.get(devId);
    if (!dev) { this.queue(p.id, { e: 'buildFail', msg: 'Dieses Gerät gibt es nicht.' }); return; }
    const pos = this.devPos(dev);
    if (dist(p.x, p.y, pos.x, pos.y) > USE_RANGE + 0.3) { this.queue(p.id, { e: 'buildFail', msg: 'Zu weit weg vom Gerät.' }); return; }
    slot = parseInt(slot, 10);
    if (!(slot >= 1 && slot <= this.wheelSize(p))) { this.queue(p.id, { e: 'buildFail', msg: 'Ungültiger Slot.' }); return; }
    if (!this.slotUnlocked(p, slot)) { this.queue(p.id, { e: 'buildFail', msg: 'Dieser Slot ist noch gesperrt – im Prank-Shop freischalten!' }); return; }
    p.path = null; p.pathThen = null;
    p.d = Math.atan2(pos.y - p.y, pos.x - p.x);
    const st = this.devState.get(dev.id);
    if (st.trap) {
      this.toast(p.id, '😱 Hoppla – da hat schon jemand eine Falle versteckt!', 'bad');
      this.triggerTrap(dev, p);
      return;
    }
    const trapId = trapForSlot(dev.type, slot);
    const tier = slotTier(slot);
    const tr = TRAPS[trapId];
    const boost = this.items && p.held.includes(tr.item) ? tr.item : null;
    p.build = { dev: dev.id, slot, trapId, t: 0, total: TIERS[tier].build * (p.perk === 'flink' ? 0.75 : 1), boost };
    p.st = 'build';
    p.noticeT = 0;
  }
  finishBuild(p) {
    const b = p.build;
    p.build = null; p.st = ''; p.noticeT = 0;
    const dev = this.map.devById.get(b.dev);
    const st = this.devState.get(b.dev);
    if (st.trap) { this.triggerTrap(dev, p); return; }
    let boost = false;
    if (b.boost) {
      const i = p.held.indexOf(b.boost);
      if (i >= 0) { p.held.splice(i, 1); boost = true; }
    }
    st.trap = { trapId: b.trapId, owner: p.id, slot: b.slot, tier: slotTier(b.slot), boost, team: p.team };
    p.brain.known.add(dev.id);
    this.queue(p.id, { e: 'built', trap: b.trapId, dev: dev.id, boost });
    this.stat(p, 'trapsBuilt', 1);
    if (this.teams && dev.team !== -1 && dev.team !== p.team) {
      this.teamScores[p.team] += 25;
      p.score += 25;
      const pos = this.devPos(dev);
      this.queue(p.id, { e: 'points', pts: 25, x: r2(pos.x), y: r2(pos.y), why: 'Sabotage im Gegner-Trakt' });
    }
    // Bots, die zugesehen haben, merken sich das Gerät
    for (const q of this.players.values()) {
      if (q !== p && q.ai && !q.hidden && this.canSeeEnt(q, p)) q.brain.known.add(dev.id);
    }
  }
  triggerTrap(dev, victim) {
    const st = this.devState.get(dev.id);
    const trap = st && st.trap;
    if (!trap) return;
    st.trap = null;
    for (const q of this.players.values()) q.brain.known.delete(dev.id);
    const pos = this.devPos(dev);
    const tr = TRAPS[trap.trapId];
    const victims = [victim];
    if (tr.area) {
      for (const q of this.players.values()) {
        if (q !== victim && !q.hidden && q.stunT <= 0 && dist(q.x, q.y, pos.x, pos.y) <= tr.area) victims.push(q);
      }
      for (const n of this.npcs) {
        if (n !== victim && n.stunT <= 0 && dist(n.x, n.y, pos.x, pos.y) <= tr.area) victims.push(n);
      }
    }
    for (const v of victims) this.applyTrap(v, trap, pos, dev);
  }
  applyTrap(v, trap, src, dev) {
    const tr = TRAPS[trap.trapId];
    const tier = TIERS[trap.tier];
    let stun = tr.fixedStun || (tier.stun + (tr.extraStun || 0));
    if (trap.boost) stun += 1.5;
    const owner = this.players.get(trap.owner) || null;
    const isSelf = v.kind === 'p' && v.id === trap.owner;
    // Opfer außer Gefecht setzen
    if (v.kind === 'p') {
      v.build = null; v.use = null; v.path = null; v.pathThen = null; v.noticeT = 0;
      if (v.dgT > 0) { v.dgT = 0; this.queue(v.id, { e: 'disguise', on: false, name: this.bdef.disguise.name }); }
    } else {
      v.path = null; v.useT = 0; v.useDev = null; v.lure = false;
    }
    v.stunT = stun; v.stunTotal = stun; v.fx = tr.fx; v.st = 'stun';
    v.knock = null;
    if (tr.fx === 'launch' || tr.fx === 'slip') {
      let dx = v.x - src.x, dy = v.y - src.y;
      let dl = Math.hypot(dx, dy);
      if (dl < 0.05) { const a = rand(0, Math.PI * 2); dx = Math.cos(a); dy = Math.sin(a); dl = 1; }
      const len = tr.fx === 'launch' ? 1.5 : 2.0, dur = tr.fx === 'launch' ? 0.45 : 0.9;
      v.knock = { vx: (dx / dl) * len / dur, vy: (dy / dl) * len / dur, t: dur };
    }
    if (v.kind === 'p') {
      v.chaos = Math.min(100, v.chaos + 20);
      v.badLuck++;
      if (v.badLuck >= 2) {
        v.badLuck = 0;
        v.adrT = stun + 6; v.radarT = stun + 8;
        this.queue(v.id, { e: 'adrenalin' });
      }
      if (this.mode === 'schatzsuche' && v.treasures.length) {
        const lost = v.treasures.splice(randInt(0, v.treasures.length - 1), 1)[0];
        v.exitOpen = false;
        // Der verlorene Schatz landet in einem der nächstgelegenen Geräte (wie im Spionage-Klassiker)
        const cands = this.map.devices.filter((d) => !DEVICE_TYPES[d.type].mobile && !this.devState.get(d.id).treasure && (!dev || d.id !== dev.id))
          .sort((a, b) => dist(a.x, a.y, v.x, v.y) - dist(b.x, b.y, v.x, v.y)).slice(0, 4);
        if (cands.length) this.devState.get(pick(cands).id).treasure = lost;
        this.queue(v.id, { e: 'treasureLost', id: lost, name: TREASURES[lost].name });
        for (const q of this.players.values()) q.brain.searched.clear();
      }
    }
    // Punkte für den Besitzer
    let pts = 0, bonus = 0;
    if (owner && !isSelf) {
      if (v.kind === 'p') {
        const friendly = this.teams && v.team === owner.team;
        if (!friendly) {
          if (this.time - owner.comboT <= 12) owner.comboN++; else owner.comboN = 1;
          owner.comboT = this.time;
          const mult = Math.min(2, 1 + 0.25 * (owner.comboN - 1));
          pts = Math.round(tier.pts * mult * (trap.boost ? 2 : 1));
          owner.badLuck = 0;
          if (owner.comboN >= 2) this.queue(owner.id, { e: 'combo', n: owner.comboN, mult: r2(mult) });
          this.stat(owner, 'playerHits', 1);
        }
      } else if (v.kind === 'n') {
        pts = 40;
        this.stat(owner, 'npcHits', 1);
      }
      if (pts > 0 && this.canSeePos(owner, v.x, v.y)) {
        bonus = 50;
        this.queue(owner.id, { e: 'schadenfreude', pts: bonus, vname: this.entName(v) });
      }
      const total = pts + bonus;
      if (total > 0) {
        owner.score += total;
        if (this.teams && owner.team >= 0) this.teamScores[owner.team] += total;
        this.queue(owner.id, { e: 'points', pts: total, x: r2(v.x), y: r2(v.y), why: v.kind === 'p' ? 'Streich gelungen' : 'NPC erwischt' });
        if (owner.bot && Math.random() < 0.5) { owner.emo = pick(['😂', '😈', '🎉']); owner.emoT = 3; this.emitEmoji(owner); }
      }
    }
    // Ereignis an alle Zuschauer (inkl. Opfer)
    const vname = this.entName(v);
    const base = {
      e: 'trap', vk: v.kind === 'p' ? 'p' : 'n', vname, trap: trap.trapId, fx: tr.fx, x: r2(v.x), y: r2(v.y),
      owner: trap.owner, oname: owner ? owner.name : '?', self: isSelf, boost: !!trap.boost
    };
    const seenBy = new Set();
    this.queueViewers(v.x, v.y, (viewer) => {
      if (viewer) seenBy.add(viewer.id);
      return Object.assign({ victim: v.kind === 'p' ? this.idFor(viewer, v) : v.id }, base);
    }, v.kind === 'p' ? [v.id] : []);
    if (owner && !isSelf && !seenBy.has(owner.id)) {
      this.queue(owner.id, { e: 'trapRemote', vname, trap: trap.trapId, pts: pts + bonus });
    }
  }
  checkCaught(dt) {
    for (const p of this.players.values()) {
      if (!p.build) continue;
      let seer = null;
      if (!(p.dgT > 0)) {
        for (const n of this.npcs) {
          if (n.stunT > 0) continue;
          if (dist(n.x, n.y, p.x, p.y) <= 7 && this.sameRooms(n, p)) { seer = n; break; }
        }
      }
      if (seer) {
        p.noticeT += dt;
        if (p.noticeT >= 0.6) { this.caught(p, 'npc', seer); continue; }
      } else p.noticeT = 0;
      for (const q of this.players.values()) {
        if (q === p || q.hidden || q.stunT > 0 || this.isTeammate(p, q)) continue;
        if (dist(q.x, q.y, p.x, p.y) <= 1.1 && this.sameRooms(q, p)) { this.caught(p, 'spieler', q); break; }
      }
    }
  }
  caught(p, by, catcher) {
    const b = p.build;
    if (!b) return;
    p.build = null; p.st = ''; p.noticeT = 0;
    const dev = this.map.devById.get(b.dev);
    if (by === 'npc') {
      catcher.alarmT = 1.6; catcher.path = null; catcher.useT = 0; catcher.useDev = null;
      catcher.emo = '❗'; catcher.emoT = 1.6;
      catcher.d = Math.atan2(p.y - catcher.y, p.x - catcher.x);
      this.queueViewers(catcher.x, catcher.y, { e: 'alarm', x: r2(catcher.x), y: r2(catcher.y), npc: this.npcName(catcher.npc) }, [p.id]);
    } else if (catcher) {
      catcher.score += 50;
      if (this.teams && catcher.team >= 0) this.teamScores[catcher.team] += 50;
      this.queue(catcher.id, { e: 'points', pts: 50, x: r2(p.x), y: r2(p.y), why: 'Fallensteller erwischt' });
    }
    this.queueViewers(p.x, p.y, (viewer) => ({ e: 'caught', id: this.idFor(viewer, p), name: p.name, x: r2(p.x), y: r2(p.y), by }), [p.id]);
    const fake = { trapId: b.trapId, owner: p.id, slot: b.slot, tier: slotTier(b.slot), boost: false, team: p.team };
    this.applyTrap(p, fake, this.devPos(dev), dev);
  }

  /* ---------- Verstecken, Verkleiden, Winken, Emoji ---------- */
  doHide(p) {
    if (p.hidden) {
      p.hidden = null;
      this.queue(p.id, { e: 'hide', on: false });
      return;
    }
    if (this.freezeT > 0 || p.stunT > 0 || p.build || p.use) return;
    const h = this.nearestHide(p);
    if (!h) { this.toast(p.id, 'Kein freies Versteck in der Nähe.', 'info'); return; }
    p.hidden = h.id; p.path = null; p.pathThen = null; p.mv = 0;
    p.d = Math.atan2(h.y + 0.5 - p.y, h.x + 0.5 - p.x);
    this.queue(p.id, { e: 'hide', on: true });
    this.stat(p, 'hides', 1);
  }
  doDisguise(p) {
    if (this.freezeT > 0 || p.stunT > 0 || p.hidden) return;
    if (p.dgT > 0) { this.toast(p.id, 'Du bist schon verkleidet.', 'info'); return; }
    if (p.dgCd > 0) { this.toast(p.id, `Verkleidung erst in ${Math.ceil(p.dgCd)} s wieder bereit.`, 'info'); return; }
    p.dgT = 12; p.dgCd = 30;
    this.queue(p.id, { e: 'disguise', on: true, name: this.bdef.disguise.name });
  }
  doWave(p) {
    if (this.freezeT > 0 || p.stunT > 0 || p.hidden) return;
    if (p.waveCd > 0) { this.toast(p.id, `Winken erst in ${Math.ceil(p.waveCd)} s wieder möglich.`, 'info'); return; }
    let npc = null, bd = 9;
    for (const n of this.npcs) {
      if (n.stunT > 0 || n.alarmT > 0) continue;
      const d = dist(n.x, n.y, p.x, p.y);
      if (d <= bd && this.sameRooms(n, p)) { bd = d; npc = n; }
    }
    p.emo = '👋'; p.emoT = 1.5; this.emitEmoji(p);
    if (!npc) {
      p.waveCd = 1;
      this.queue(p.id, { e: 'wave', ok: false, npc: null });
      this.toast(p.id, 'Kein NPC in Sichtweite zum Herwinken.', 'info');
      return;
    }
    let dev = null, dd = 3;
    for (const d of this.map.devices) {
      if (DEVICE_TYPES[d.type].mobile) continue;
      const pos = this.devPos(d);
      const x = dist(p.x, p.y, pos.x, pos.y);
      if (x <= dd) { dd = x; dev = d; }
    }
    npc.lure = true; npc.useT = 0; npc.waitT = 0;
    let ok = false;
    if (dev) ok = this.npcGoUse(npc, dev);
    if (!ok) {
      const k = Math.floor(p.y) * this.map.w + Math.floor(p.x);
      const path = this.map.findPath(npc.x, npc.y, [k].concat(this.map.interactTiles(Math.floor(p.x), Math.floor(p.y))));
      if (path) { npc.path = path; npc.useDev = null; }
    }
    p.waveCd = 8;
    const name = this.npcName(npc.npc);
    this.queue(p.id, { e: 'wave', ok: true, npc: name });
    this.queue(p.id, { e: 'say', text: pick(['Na gut, ich probier\'s mal!', 'Ich komme schon!', 'Ja, ja, schon unterwegs!', 'Was gibt\'s denn?']) });
    npc.emo = '👍'; npc.emoT = 1.5;
    this.stat(p, 'waves', 1);
  }
  emitEmoji(p) {
    this.queueViewers(p.x, p.y, (viewer) => ({ e: 'emoji', id: this.idFor(viewer, p), emoji: p.emo }), [p.id]);
  }
  doEmoji(p, e) {
    if (!EMOTES.includes(e)) return;
    if (!p.bot && EMOTES.indexOf(e) >= 4) {
      const rec = p.profileKey ? DB.players[p.profileKey] : null;
      if (!rec || !owns(rec, 'emote:' + e)) { this.toast(p.id, 'Dieses Emoji gibt es im Prank-Shop.', 'info'); return; }
    }
    if (p.hidden) return;
    p.emo = e; p.emoT = 3;
    this.emitEmoji(p);
  }
  moveTo(p, x, y, then) {
    if (p.stunT > 0 || p.build || p.use) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (p.hidden) { p.hidden = null; this.queue(p.id, { e: 'hide', on: false }); }
    const ti = Math.floor(x), tj = Math.floor(y);
    if (!this.map.inside(ti, tj)) return;
    let goals;
    let dev = null, hide = null;
    for (const d of this.map.devices) {
      const pos = this.devPos(d);
      if (DEVICE_TYPES[d.type].mobile ? dist(pos.x, pos.y, x, y) < 0.7 : (d.x === ti && d.y === tj)) { dev = d; break; }
    }
    if (!dev) hide = this.map.hides.find((h) => h.x === ti && h.y === tj) || null;
    if (dev) {
      const pos = this.devPos(dev);
      goals = this.map.interactTiles(Math.floor(pos.x), Math.floor(pos.y));
      if (DEVICE_TYPES[dev.type].mobile) goals.push(Math.floor(pos.y) * this.map.w + Math.floor(pos.x));
    } else if (hide) goals = this.map.interactTiles(hide.x, hide.y);
    else if (this.map.passable(ti, tj)) goals = [tj * this.map.w + ti];
    else if (this.map.tiles[tj * this.map.w + ti] === T_EXIT) goals = [this.map.exit.fy * this.map.w + this.map.exit.fx];
    else goals = this.map.interactTiles(ti, tj);
    if (!goals.length) return;
    const path = this.map.findPath(p.x, p.y, goals);
    if (!path) { this.toast(p.id, 'Da komme ich nicht hin.', 'info'); return; }
    if (!dev && !hide && this.map.passable(ti, tj) && path.length) path[path.length - 1] = [x, y];
    p.path = path;
    p.input = { x: 0, y: 0 };
    let act = null;
    if (then === 'use') act = dev ? { act: 'use', dev: dev.id } : 'use';
    else if (then === 'hide') act = 'hide';
    p.pathThen = act;
    if (!path.length && act) { p.path = null; p.pathThen = null; this.onArrive(p, act); }
  }

  /* ---------- Saugroboter ---------- */
  robotStep(r, dt) {
    let busy = false;
    for (const p of this.players.values()) if (p.build && p.build.dev === r.id) { busy = true; break; }
    if (busy) { r.mv = 0; return; }
    if (r.waitT > 0) { r.waitT -= dt; r.mv = 0; }
    else if (!r.path || !r.path.length) {
      const tiles = this.roomTiles[r.room];
      if (tiles && tiles.length) {
        const k = pick(tiles);
        r.path = this.map.findPath(r.x, r.y, [k]);
      }
      if (!r.path) r.waitT = 1;
    } else {
      const arrived = this.followPath(r, ROBOT_SPEED, dt, 0.25);
      if (arrived) { r.path = null; r.waitT = rand(0.5, 2.5); r.mv = 0; }
    }
    const st = this.devState.get(r.id);
    if (st && st.trap) {
      for (const p of this.players.values()) {
        if (p.hidden || p.stunT > 0) continue;
        if (dist(p.x, p.y, r.x, r.y) < 0.7) { this.triggerTrap(r.dev, p); return; }
      }
      for (const n of this.npcs) {
        if (n.stunT > 0) continue;
        if (dist(n.x, n.y, r.x, r.y) < 0.7) { this.triggerTrap(r.dev, n); return; }
      }
    }
  }

  /* ---------- Ende ---------- */
  win(p) {
    if (this.over || this.practice) return;
    this.queueAll({ e: 'win', id: p.id, name: p.name, team: p.team });
    this.endRound(p, this.mode === 'schatzsuche' ? 'schaetze' : 'exit');
  }
  endRound(winnerP, reason) {
    if (this.over) return;
    this.over = true;
    this.room.onGameOver(this, winnerP, reason);
  }
  computeResults(winnerP, reason) {
    const list = [...this.players.values()];
    const prog = (p) => (this.mode === 'checkliste' ? p.tasks.filter((t) => t.done).length : this.mode === 'schatzsuche' ? p.treasures.length : p.score);
    list.sort((a, b) => {
      if (winnerP) { if (a === winnerP) return -1; if (b === winnerP) return 1; }
      if (this.teams) {
        const ta = this.teamScores[a.team] || 0, tb = this.teamScores[b.team] || 0;
        if (ta !== tb) return tb - ta;
      }
      if (this.mode === 'checkliste' || this.mode === 'schatzsuche') { const d = prog(b) - prog(a); if (d) return d; }
      return b.score - a.score;
    });
    let winner = null;
    const winners = new Set();
    if (this.teams) {
      if (this.teamScores[0] !== this.teamScores[1]) {
        const t = this.teamScores[0] > this.teamScores[1] ? 0 : 1;
        winner = { team: t, name: TEAMS[t].name };
        for (const p of list) if (p.team === t) winners.add(p.id);
      }
    } else if (winnerP) {
      winner = { id: winnerP.id, name: winnerP.name };
      winners.add(winnerP.id);
    } else if (list.length) {
      const a = list[0], b = list[1];
      const tie = b && prog(a) === prog(b) && a.score === b.score;
      if (!tie) { winner = { id: a.id, name: a.name }; winners.add(a.id); }
    }
    if (winner && reason === 'time' && !this.teams) this.queueAll({ e: 'win', id: winner.id, name: winner.name, team: -1 });
    if (winner && this.teams) this.queueAll({ e: 'win', id: null, name: winner.name, team: winner.team });
    return {
      mode: this.mode, winner, reason, winners,
      ranking: list.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, prog: prog(p), team: p.team, bot: p.bot })),
      teamScores: this.teams ? this.teamScores.slice() : null
    };
  }

  /* ---------- Snapshot ---------- */
  nearInfo(p) {
    const dev = this.nearestDevice(p, USE_RANGE);
    const hide = p.hidden ? this.map.hideById.get(p.hidden) : this.nearestHide(p);
    let pk = null;
    if (this.items) { let bd = 1.0; for (const it of this.pickups) { const d = dist(p.x, p.y, it.x, it.y); if (d < bd) { bd = d; pk = it.id; } } }
    let npc = false;
    for (const n of this.npcs) if (n.stunT <= 0 && dist(n.x, n.y, p.x, p.y) <= 9 && this.sameRooms(n, p)) { npc = true; break; }
    return { dev: dev ? dev.id : null, hide: hide ? hide.id : null, exit: dist(p.x, p.y, this.exitPos.x, this.exitPos.y) < 1.6, pickup: pk, npc };
  }
  entFor(viewer, q) {
    const base = { x: r2(q.x), y: r2(q.y), d: r2(q.d || 0), mv: q.mv ? 1 : 0 };
    if (q.kind === 'r') return Object.assign({ id: q.id, k: 'r' }, base);
    const st = q.st || '';
    let p = 0;
    if (q.kind === 'p') {
      if (q.build) p = r2(q.build.t / q.build.total);
      else if (q.use) p = r2(q.use.t / q.use.total);
    } else if (q.kind === 'n' && q.useT > 0) p = r2(1 - q.useT / 1.5);
    const common = { st, p, fx: q.stunT > 0 ? q.fx : null, fxT: q.stunT > 0 ? r1(q.stunT) : 0, emo: q.emoT > 0 ? q.emo : null };
    if (q.kind === 'n') return Object.assign({ id: q.id, k: 'n', npc: q.npc, tm: -1 }, base, common);
    // Spieler
    const ally = !viewer || viewer === q || this.isTeammate(viewer, q);
    if (q.dgT > 0 && !ally) {
      return Object.assign({ id: 'v' + q.id, k: 'n', npc: this.bdef.disguise.npc, tm: -1 }, base, common);
    }
    return Object.assign({ id: q.id, k: 'p', need: q.need, tm: q.team, it: q.treasures.length, dg: q.dgT > 0 && ally }, base, common);
  }
  snapFor(m) {
    const viewer = m.spectator ? null : this.players.get(m.id) || null;
    const spec = !viewer;
    const snap = {
      t: Date.now(),
      tl: this.duration ? r1(Math.max(0, this.duration - this.elapsed)) : null,
      spec, follow: null, me: null, e: [], steps: [], pk: [], sb: [], ts: this.teams ? this.teamScores.slice() : null
    };
    if (viewer) {
      const p = viewer;
      const radar = [];
      if (p.radarT > 0) {
        for (const d of this.map.devices) {
          if (!this.devState.get(d.id).trap) continue;
          const pos = this.devPos(d);
          if (dist(pos.x, pos.y, p.x, p.y) <= 7) radar.push([r2(pos.x), r2(pos.y)]);
        }
      }
      const myTraps = [];
      if (p.perk === 'meisterhirn') {
        for (const d of this.map.devices) {
          const st = this.devState.get(d.id);
          if (st.trap && st.trap.owner === p.id) { const pos = this.devPos(d); myTraps.push([r2(pos.x), r2(pos.y), st.trap.trapId]); }
        }
      }
      snap.me = {
        id: p.id, x: r2(p.x), y: r2(p.y), spd: r2(this.freezeT > 0 ? 0 : this.speedOf(p)), st: p.hidden ? '' : p.st, fx: p.stunT > 0 ? p.fx : null, fxT: p.stunT > 0 ? r1(p.stunT) : 0,
        need: p.need, needT: r1(p.needT), needMax: NEED_MAX, slow: p.slow,
        boost: r1(p.boostT), adr: r1(p.adrT), radar, myTraps,
        build: p.build ? { dev: p.build.dev, trap: p.build.trapId, p: r2(p.build.t / p.build.total) } : null,
        use: p.use ? { dev: p.use.dev, p: r2(p.use.t / p.use.total) } : null,
        hidden: p.hidden, dg: r1(p.dgT), dgCd: r1(p.dgCd), waveCd: r1(p.waveCd),
        tasks: p.tasks.map((t) => ({ label: t.label, icon: t.icon, type: t.type, done: t.done })),
        treasures: p.treasures.slice(), held: p.held.slice(),
        exitOpen: p.exitOpen, score: p.score, chaos: p.chaos, combo: this.time - p.comboT <= 12 ? p.comboN : 0, team: p.team,
        near: this.nearInfo(p)
      };
    }
    for (const q of this.players.values()) {
      if (q === viewer || q.hidden) continue;
      if (viewer && !this.canSeeEnt(viewer, q)) continue;
      snap.e.push(this.entFor(viewer, q));
    }
    for (const n of this.npcs) if (!viewer || this.canSeeEnt(viewer, n)) snap.e.push(this.entFor(viewer, n));
    for (const r of this.robots) if (!viewer || this.sameRooms(viewer, r)) snap.e.push(this.entFor(viewer, r));
    if (viewer) {
      const add = (e) => {
        if (!e.mv || dist(e.x, e.y, viewer.x, viewer.y) > 10) return;
        snap.steps.push([Math.round(e.x * 2) / 2, Math.round(e.y * 2) / 2]);
      };
      for (const q of this.players.values()) {
        if (q === viewer || q.hidden || q.perk === 'leise' || this.canSeeEnt(viewer, q)) continue;
        add(q);
      }
      for (const n of this.npcs) if (!this.canSeeEnt(viewer, n)) add(n);
    }
    for (const it of this.pickups) {
      if (!viewer || this.canSeePos(viewer, it.x, it.y)) snap.pk.push({ id: it.id, item: it.item, x: r2(it.x), y: r2(it.y) });
    }
    let leader = null;
    for (const q of this.players.values()) {
      const prog = this.mode === 'checkliste' ? q.tasks.filter((t) => t.done).length : this.mode === 'schatzsuche' ? q.treasures.length : q.score;
      snap.sb.push({ id: q.id, name: q.name, score: q.score, prog, team: q.team, bot: q.bot });
      if (!leader || prog > leader.prog || (prog === leader.prog && q.score > leader.score)) leader = { id: q.id, prog, score: q.score };
    }
    if (spec) snap.follow = leader ? leader.id : null;
    return snap;
  }
  worldFor(m) {
    return {
      map: this.map.toClient(),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, team: p.team, bot: p.bot })),
      mode: this.mode, settings: Object.assign({}, this.settings), practice: this.practice,
      duration: this.duration, you: m.id, spectator: !!m.spectator || !this.players.has(m.id)
    };
  }
  flush(io) {
    for (const m of this.room.members.values()) {
      if (!m.socketId) continue;
      const s = io.sockets.sockets.get(m.socketId);
      if (!s) continue;
      if (!this.over) s.volatile.emit('snap', this.snapFor(m));
      const evs = this.out.get(m.socketId);
      if (evs && evs.length) s.emit('ev', evs);
    }
    this.out.clear();
  }
}

/* ---------------------------------------------------------------------
 *  NPCs (neutrale Alltagsfiguren) und Mitspieler-Bots
 * ------------------------------------------------------------------- */
Game.prototype.npcGoUse = function (n, dev) {
  const goals = this.map.interactTiles(dev.x, dev.y);
  if (!goals.length) return false;
  const path = this.map.findPath(n.x, n.y, goals);
  if (!path) return false;
  n.path = path; n.useDev = dev.id; n.pathStuck = 0;
  return true;
};

Game.prototype.npcStep = function (n, dt) {
  if (n.emoT > 0) { n.emoT -= dt; if (n.emoT <= 0) n.emo = null; }
  if (n.stunT > 0) {
    n.stunT -= dt; n.mv = 0;
    if (n.knock && n.knock.t > 0) { this.moveEnt(n, n.knock.vx, n.knock.vy, Math.min(dt, n.knock.t)); n.knock.t -= dt; }
    if (n.stunT <= 0) { n.stunT = 0; n.fx = null; n.st = ''; n.knock = null; n.waitT = rand(1, 2); n.path = null; n.useDev = null; }
    return;
  }
  if (n.alarmT > 0) { n.alarmT -= dt; n.mv = 0; return; }
  if (n.useT > 0) {
    n.useT -= dt; n.st = 'use'; n.mv = 0;
    if (n.useT <= 0) { n.useT = 0; n.st = ''; n.useDev = null; n.lure = false; n.waitT = rand(2, 5); }
    return;
  }
  if (n.path && n.path.length) {
    const arrived = this.followPath(n, NPC_SPEED * (n.lure ? 1.3 : 1), dt);
    if (!arrived) return;
    n.path = null; n.mv = 0;
  }
  if (n.useDev) {
    const dev = this.map.devById.get(n.useDev);
    const pos = dev ? this.devPos(dev) : null;
    if (dev && dist(n.x, n.y, pos.x, pos.y) <= USE_RANGE + 0.2) {
      n.d = Math.atan2(pos.y - n.y, pos.x - n.x);
      const st = this.devState.get(dev.id);
      if (st.trap) { n.useDev = null; this.triggerTrap(dev, n); return; }
      n.useT = 1.5; n.st = 'use';
      return;
    }
    n.useDev = null; n.lure = false; n.waitT = rand(0.5, 1.5);
    return;
  }
  if (n.waitT > 0) { n.waitT -= dt; n.mv = 0; return; }
  // neues Ziel: ein zufälliges Gerät (bevorzugt in der Nähe)
  const devs = this.map.devices.filter((d) => !DEVICE_TYPES[d.type].mobile);
  if (!devs.length) { n.waitT = 3; return; }
  let target;
  if (Math.random() < 0.55) {
    const near = devs.filter((d) => dist(d.x + 0.5, d.y + 0.5, n.x, n.y) < 10);
    target = near.length ? pick(near) : pick(devs);
  } else target = pick(devs);
  if (!this.npcGoUse(n, target)) n.waitT = rand(1, 2);
};

/* ---------- Bots ---------- */
Game.prototype.botSlot = function (p) {
  const max = this.party ? 9 : Math.min(this.wheelSize(p), Math.max(3, p.slots || 3));
  const opts = [];
  for (let s = 1; s <= max; s++) if (this.slotUnlocked(p, s)) opts.push(s);
  return pick(opts);
};
Game.prototype.botGoDevice = function (p, dev, then) {
  const pos = this.devPos(dev);
  if (dist(p.x, p.y, pos.x, pos.y) <= USE_RANGE - 0.1) { this.onArrive(p, then); return true; }
  const goals = this.map.interactTiles(Math.floor(pos.x), Math.floor(pos.y));
  if (DEVICE_TYPES[dev.type].mobile) goals.push(Math.floor(pos.y) * this.map.w + Math.floor(pos.x));
  const path = this.map.findPath(p.x, p.y, goals);
  if (!path) return false;
  p.path = path; p.pathThen = then; p.input = { x: 0, y: 0 };
  if (!path.length) { p.path = null; p.pathThen = null; this.onArrive(p, then); }
  return true;
};
Game.prototype.botNearestOfTypes = function (p, types, avoidKnown) {
  let best = null, bd = Infinity;
  for (const d of this.map.devices) {
    if (!types.includes(d.type)) continue;
    if (avoidKnown && p.brain.known.has(d.id)) continue;
    const pos = this.devPos(d);
    const dd = dist(p.x, p.y, pos.x, pos.y);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
};
Game.prototype.botWatched = function (p) {
  const out = { npc: false, player: false };
  for (const n of this.npcs) {
    if (n.stunT > 0) continue;
    if (dist(n.x, n.y, p.x, p.y) <= 7.5 && this.sameRooms(n, p)) { out.npc = true; break; }
  }
  for (const q of this.players.values()) {
    if (q === p || q.hidden || q.stunT > 0 || this.isTeammate(p, q)) continue;
    if (dist(q.x, q.y, p.x, p.y) <= 2.5 && this.sameRooms(q, p)) { out.player = true; break; }
  }
  return out;
};
Game.prototype.botThink = function (p, dt) {
  const b = p.brain;
  if (p.stunT > 0 || p.build || p.use) return;
  if (p.hidden) {
    b.hideT -= dt;
    if (b.hideT <= 0) { p.hidden = null; b.thinkT = 0.2; }
    return;
  }
  b.buildCd -= dt;
  b.thinkT -= dt;
  // Feststecken erkennen
  if (p.path && p.path.length) {
    if (dist(p.x, p.y, b.lastX, b.lastY) < 0.02) b.stillT += dt; else b.stillT = 0;
    b.lastX = p.x; b.lastY = p.y;
    if (b.stillT > 1.5) { b.stillT = 0; p.path = null; p.pathThen = null; b.thinkT = 0; }
    if (b.thinkT > 0) return;
  }
  if (b.thinkT > 0) return;
  b.thinkT = rand(0.35, 0.7);
  p.input = { x: 0, y: 0 };

  // 1) Gelegenheits-Falle am Gerät in Reichweite
  const near = this.nearestDevice(p, USE_RANGE);
  if (near && b.buildCd <= 0 && !b.known.has(near.id)) {
    let chance = { chaos: 0.6, teams: 0.12, checkliste: 0.28, schatzsuche: 0.15, uebung: 0.1 }[this.mode] || 0.2;
    if (this.teams && near.team !== -1 && near.team !== p.team) chance = 0.95;
    if (NEED_DEVICE_TYPES.includes(near.type)) chance += 0.15;
    if (Math.random() < chance) {
      const w = this.botWatched(p);
      // Von NPCs beobachtet? Dann zuerst verkleiden (schützt vor dem NPC-Alarm)
      if (w.npc && !w.player && p.dgT <= 0 && p.dgCd <= 0 && Math.random() < 0.6) this.doDisguise(p);
      const safe = !w.player && (!w.npc || p.dgT > 0);
      if (safe || Math.random() < 0.08) {
        this.actTrap(p, near.id, this.botSlot(p));
        b.buildCd = this.mode === 'chaos' ? rand(3, 8) : rand(7, 15);
        return;
      }
      b.buildCd = rand(1, 3);
    }
  }
  // 2) Sich verstecken, wenn ein Gegner auftaucht
  if (Math.random() < 0.06 && !p.exitOpen) {
    let threat = false;
    for (const q of this.players.values()) {
      if (q !== p && !q.hidden && !this.isTeammate(p, q) && this.sameRooms(p, q) && dist(p.x, p.y, q.x, q.y) < 7) { threat = true; break; }
    }
    if (threat) {
      const h = this.map.hides.find((x) => !this.hideOccupant(x.id) && dist(p.x, p.y, x.x + 0.5, x.y + 0.5) < 5);
      if (h) {
        b.hideT = rand(3, 6);
        if (dist(p.x, p.y, h.x + 0.5, h.y + 0.5) <= HIDE_RANGE) { this.doHide(p); return; }
        const path = this.map.findPath(p.x, p.y, this.map.interactTiles(h.x, h.y));
        if (path) { p.path = path; p.pathThen = { act: 'hide' }; return; }
      }
    }
  }
  if (p.path && p.path.length) return;
  // 3) Ausgang
  if (p.exitOpen) {
    const path = this.map.findPath(p.x, p.y, [this.map.exit.fy * this.map.w + this.map.exit.fx]);
    if (path && path.length) { p.path = path; p.pathThen = { act: 'exit' }; return; }
    this.doUse(p);
    return;
  }
  // 4) Bedürfnis
  if (p.need && (p.needT > 2 || p.slow || this.mode === 'chaos')) {
    const types = NEED_DEFS[p.need].types;
    let dev = this.botNearestOfTypes(p, types, true);
    if (!dev) {
      dev = this.botNearestOfTypes(p, types, false);
      if (dev && p.waveCd <= 0 && Math.random() < 0.6) this.doWave(p);
    }
    if (dev && p.waveCd <= 0 && Math.random() < 0.15) {
      const pos = this.devPos(dev);
      if (dist(p.x, p.y, pos.x, pos.y) < 3 && this.npcs.some((n) => n.stunT <= 0 && this.sameRooms(n, p))) { this.doWave(p); b.thinkT = rand(2, 4); return; }
    }
    if (dev && this.botGoDevice(p, dev, { act: 'use', dev: dev.id })) return;
  }
  // 5) Modusziel – mit etwas Schabernack zwischendurch
  if ((this.mode === 'checkliste' || this.mode === 'schatzsuche') && b.buildCd <= 0 && Math.random() < (this.mode === 'checkliste' ? 0.45 : 0.15)) {
    const targets = new Set(NEED_DEVICE_TYPES);
    for (const q of this.players.values()) if (q !== p) for (const t of q.tasks) if (!t.done) targets.add(t.type);
    const devs = this.map.devices.filter((d) => targets.has(d.type) && !b.known.has(d.id) && dist(p.x, p.y, d.x, d.y) < 14);
    if (devs.length) {
      const dev = pick(devs);
      if (this.botGoDevice(p, dev, { act: 'trap', dev: dev.id, slot: this.botSlot(p) })) { b.buildCd = rand(8, 16); return; }
    }
  }
  if (this.mode === 'checkliste') {
    const task = p.tasks.find((t) => !t.done);
    if (task) {
      const dev = this.botNearestOfTypes(p, [task.type], true) || this.botNearestOfTypes(p, [task.type], false);
      if (dev && this.botGoDevice(p, dev, { act: 'use', dev: dev.id })) return;
    }
  } else if (this.mode === 'schatzsuche') {
    const cands = this.map.devices.filter((d) => !DEVICE_TYPES[d.type].mobile && !b.known.has(d.id) &&
      !(b.searched.has(d.id) && this.time - b.searched.get(d.id) < 45));
    if (cands.length) {
      cands.sort((a, c) => dist(p.x, p.y, a.x, a.y) - dist(p.x, p.y, c.x, c.y));
      const dev = cands[Math.min(cands.length - 1, randInt(0, 2))];
      if (this.botGoDevice(p, dev, { act: 'use', dev: dev.id })) return;
    } else b.searched.clear();
  } else if (this.mode === 'teams') {
    const enemy = this.map.devices.filter((d) => d.team !== -1 && d.team !== p.team && !b.known.has(d.id));
    if (enemy.length && Math.random() < 0.8) {
      const pref = enemy.filter((d) => NEED_DEVICE_TYPES.includes(d.type));
      const dev = pref.length && Math.random() < 0.6 ? pick(pref) : pick(enemy);
      if (this.botGoDevice(p, dev, { act: 'trap', dev: dev.id, slot: this.botSlot(p) })) { b.buildCd = 0; return; }
    }
  } else if (this.mode === 'chaos') {
    const devs = this.map.devices.filter((d) => !b.known.has(d.id));
    if (devs.length) {
      let dev;
      const busy = [...this.players.values()].filter((q) => q !== p && q.need);
      if (busy.length && Math.random() < 0.5) {
        const q = pick(busy);
        dev = this.botNearestOfTypes(q, NEED_DEFS[q.need].types, false);
      }
      if (!dev || b.known.has(dev.id)) dev = pick(devs);
      if (this.botGoDevice(p, dev, { act: 'trap', dev: dev.id, slot: this.botSlot(p) })) { b.buildCd = 0; return; }
    }
  }
  // 6) Herumschlendern
  const s = this.randomTile(this.teams && Math.random() < 0.5 ? (r) => r.team === p.team : null);
  if (s) {
    const path = this.map.findPath(p.x, p.y, [Math.floor(s.y) * this.map.w + Math.floor(s.x)]);
    if (path && path.length) { p.path = path; p.pathThen = null; }
  }
};

/* ---------------------------------------------------------------------
 *  RÄUME / LOBBY
 * ------------------------------------------------------------------- */
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 6;
const rooms = new Map();
let memberCounter = 0;
let roomsDirty = true;
let io = null;

function newRoomCode() {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let k = 0; k < 4; k++) c += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return 'X' + Date.now().toString(36).slice(-3).toUpperCase();
}
function sockOf(id) { return id ? io.sockets.sockets.get(id) : null; }

class Room {
  constructor(code) {
    this.code = code;
    this.members = new Map();
    this.hostId = null;
    this.state = 'lobby';
    this.settings = { mode: 'checkliste', building: 'buero', duration: 3, trapRule: 'schnell', party: false };
    this.game = null;
    this.resultsTimer = null;
    this.emptySince = null;
    this.lastResults = null;
    this.created = Date.now();
  }
  humans() { return [...this.members.values()].filter((m) => !m.bot); }
  connectedHumans() { return this.humans().filter((m) => m.socketId); }
  participants() { return [...this.members.values()].filter((m) => !m.spectator && (m.bot || m.socketId || m.ai)); }
  host() { return this.members.get(this.hostId) || null; }
  hostRec() { const h = this.host(); return h && h.profileKey ? DB.players[h.profileKey] : null; }
  count() { return [...this.members.values()].filter((m) => !m.spectator).length; }
  stateFor(m) {
    return {
      code: this.code, host: this.hostId, you: m.id, state: this.state, settings: Object.assign({}, this.settings), max: MAX_PLAYERS,
      players: [...this.members.values()].filter((x) => !x.spectator || x.id === m.id).map((x) => ({
        id: x.id, name: x.name, avatar: x.avatar, bot: !!x.bot, team: x.team, level: x.level, ai: !!x.ai && !x.bot, spectator: !!x.spectator, host: x.id === this.hostId
      }))
    };
  }
  emitRoom() {
    for (const m of this.members.values()) {
      const s = sockOf(m.socketId);
      if (s) s.emit('room', this.stateFor(m));
    }
    roomsDirty = true;
  }
  sendEv(m, evs) { const s = sockOf(m.socketId); if (s) s.emit('ev', evs); }
  sendWorld(m) {
    const s = sockOf(m.socketId);
    if (s && this.game) s.emit('world', this.game.worldFor(m));
  }
  pushProfile(memberId) {
    const m = this.members.get(memberId);
    if (!m || !m.profileKey) return;
    const s = sockOf(m.socketId);
    if (s) s.emit('profile', profileOut(DB.players[m.profileKey], s.data.code));
  }
  assignTeam(m) {
    if (this.settings.mode !== 'teams') { m.team = -1; return; }
    const parts = [...this.members.values()].filter((x) => x !== m && !x.spectator);
    const a = parts.filter((x) => x.team === 0).length, b = parts.filter((x) => x.team === 1).length;
    m.team = a <= b ? 0 : 1;
  }
  rebalanceTeams() {
    const parts = [...this.members.values()].filter((x) => !x.spectator);
    if (this.settings.mode !== 'teams') { for (const m of parts) m.team = -1; return; }
    if (parts.some((m) => m.team !== 0 && m.team !== 1)) parts.forEach((m, i) => { m.team = i % 2; });
    let a = parts.filter((m) => m.team === 0), b = parts.filter((m) => m.team === 1);
    while (Math.abs(a.length - b.length) > 1) {
      const from = a.length > b.length ? a : b;
      const mv = from.find((x) => x.bot) || from[from.length - 1];
      mv.team = mv.team === 0 ? 1 : 0;
      a = parts.filter((m) => m.team === 0); b = parts.filter((m) => m.team === 1);
    }
  }
  startPractice() {
    this.game = new Game(this, { practice: true, participants: this.humans().filter((m) => m.socketId) });
  }
  addBot() {
    if (this.count() >= MAX_PLAYERS) return null;
    const used = new Set([...this.members.values()].map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || ('Bot ' + (memberCounter + 1));
    const m = { id: 'b' + (++memberCounter), name, avatar: randomAvatar(true), bot: true, team: -1, level: randInt(1, 12), socketId: null, profileKey: null, ai: true, spectator: false };
    this.assignTeam(m);
    this.members.set(m.id, m);
    return m;
  }
  removeBot() {
    const bots = [...this.members.values()].filter((m) => m.bot);
    if (!bots.length) return false;
    this.members.delete(bots[bots.length - 1].id);
    return true;
  }
  ensureHost() {
    const h = this.host();
    if (h && h.socketId) return;
    const next = this.connectedHumans().find((m) => !m.spectator) || this.connectedHumans()[0];
    if (next) this.hostId = next.id;
  }
  start() {
    // getrennte Menschen aus der letzten Runde entfernen
    for (const m of [...this.members.values()]) if (!m.bot && !m.socketId) this.members.delete(m.id);
    const mode = this.settings.mode;
    const min = MODES[mode].min;
    while (this.participants().length < min && this.count() < MAX_PLAYERS) this.addBot();
    this.rebalanceTeams();
    if (mode === 'teams') {
      const parts = this.participants();
      if (!parts.some((m) => m.team === 0) || !parts.some((m) => m.team === 1)) return 'Beide Teams brauchen mindestens einen Spieler.';
    }
    for (const m of this.members.values()) m.spectator = false;
    if (this.resultsTimer) { clearTimeout(this.resultsTimer); this.resultsTimer = null; }
    this.game = new Game(this, { practice: false, participants: this.participants() });
    this.state = 'playing';
    this.lastResults = null;
    for (const m of this.members.values()) this.sendWorld(m);
    this.emitRoom();
    return null;
  }
  onGameOver(game, winnerP, reason) {
    const res = game.computeResults(winnerP, reason);
    game.flush(io);
    this.state = 'results';
    for (const m of this.members.values()) {
      const p = game.players.get(m.id);
      let you = null;
      if (p && !m.bot && m.profileKey && DB.players[m.profileKey]) {
        const rec = DB.players[m.profileKey];
        const won = res.winners.has(p.id);
        const xp = Math.round(40 + Math.max(0, p.score) / 10 + (won ? 100 : 0));
        const coins = Math.round(15 + Math.max(0, p.score) / 20 + (won ? 40 : 0));
        const lvBefore = rec.level;
        rec.coins += coins;
        addXp(rec, xp);
        rec.stats.points = (rec.stats.points || 0) + Math.max(0, p.score);
        const daily = p.dailyDone.slice();
        daily.push(...bumpStat(rec, 'rounds', 1));
        if (won) daily.push(...bumpStat(rec, 'wins', 1));
        rec.seen = Date.now();
        saveSoon();
        lbCache = null;
        you = { xp, coins, levelUp: rec.level > lvBefore, level: rec.level, dailyDone: daily };
        m.level = rec.level;
      }
      const payload = {
        mode: res.mode, winner: res.winner, reason: res.reason, ranking: res.ranking, teamScores: res.teamScores, you
      };
      const s = sockOf(m.socketId);
      if (s) {
        s.emit('results', payload);
        if (m.profileKey && DB.players[m.profileKey]) s.emit('profile', profileOut(DB.players[m.profileKey], s.data.code));
      }
    }
    this.lastResults = res;
    this.emitRoom();
    if (this.resultsTimer) clearTimeout(this.resultsTimer);
    this.resultsTimer = setTimeout(() => { this.resultsTimer = null; if (rooms.get(this.code) === this && this.state === 'results') this.backToLobby(); }, 12000);
  }
  backToLobby() {
    if (this.resultsTimer) { clearTimeout(this.resultsTimer); this.resultsTimer = null; }
    for (const m of [...this.members.values()]) {
      if (!m.bot && !m.socketId) this.members.delete(m.id);
      else { m.spectator = false; m.ai = !!m.bot; }
    }
    this.ensureHost();
    this.rebalanceTeams();
    this.state = 'lobby';
    this.startPractice();
    for (const m of this.members.values()) this.sendWorld(m);
    this.emitRoom();
  }
}

function roomList() {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.connectedHumans().length) continue;
    const h = r.host();
    list.push({ code: r.code, host: h ? h.name : '?', count: r.count(), max: MAX_PLAYERS, state: r.state, mode: r.settings.mode, building: r.settings.building });
  }
  list.sort((a, b) => (a.state === 'lobby' ? 0 : 1) - (b.state === 'lobby' ? 0 : 1));
  return list;
}

function joinRoom(socket, room) {
  const key = socket.data.key;
  const rec = DB.players[key];
  // gleicher Spielstand schon im Raum? → Figur übernehmen (Reconnect / anderes Gerät)
  let m = [...room.members.values()].find((x) => !x.bot && x.profileKey === key);
  if (m) {
    const old = sockOf(m.socketId);
    if (old && old.id !== socket.id) {
      old.data.roomCode = null;
      old.emit('ev', [{ e: 'toast', msg: 'Du bist auf einem anderen Gerät oder Tab in diesen Raum gewechselt.', kind: 'info' }]);
    }
    m.socketId = socket.id;
    m.ai = false;
    m.name = rec.name; m.avatar = rec.avatar; m.level = rec.level;
    if (room.game) {
      const p = room.game.players.get(m.id);
      if (p) { p.ai = false; p.input = { x: 0, y: 0 }; p.path = null; }
      else if (room.state === 'lobby') room.game.addPlayer(m);
    }
  } else {
    if (room.state !== 'playing' && room.count() >= MAX_PLAYERS) return 'Der Raum ist leider voll (6/6).';
    m = { id: 'p' + (++memberCounter), name: rec.name, avatar: rec.avatar, bot: false, team: -1, level: rec.level, socketId: socket.id, profileKey: key, ai: false, spectator: room.state !== 'lobby' };
    if (room.state === 'playing' && room.members.size >= 12) return 'Der Raum ist leider voll.';
    room.assignTeam(m);
    room.members.set(m.id, m);
    if (room.state === 'lobby' && room.game) room.game.addPlayer(m);
    for (const o of room.members.values()) if (o !== m && o.socketId) room.sendEv(o, [{ e: 'joined', name: m.name }]);
  }
  socket.data.roomCode = room.code;
  socket.data.memberId = m.id;
  room.emptySince = null;
  room.ensureHost();
  socket.join('room:' + room.code);
  room.sendWorld(m);
  room.emitRoom();
  if (room.state === 'results' && room.lastResults) {
    // Nachzügler bekommen das Ergebnis ebenfalls angezeigt
    const res = room.lastResults;
    socket.emit('results', { mode: res.mode, winner: res.winner, reason: res.reason, ranking: res.ranking, teamScores: res.teamScores, you: null });
  }
  return null;
}

function leaveRoom(socket, reason) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.data.roomCode = null;
  socket.leave('room:' + code);
  const room = rooms.get(code);
  if (!room) return;
  const m = room.members.get(socket.data.memberId);
  if (!m || m.socketId !== socket.id) return;
  const playing = room.state === 'playing' && room.game && room.game.players.has(m.id) && !room.game.over;
  if (playing) {
    // KI übernimmt die Figur, bis der Spieler zurückkommt
    m.socketId = null; m.ai = true;
    const p = room.game.players.get(m.id);
    p.ai = true; p.input = { x: 0, y: 0 };
  } else {
    room.members.delete(m.id);
    if (room.game && room.state === 'lobby') room.game.removePlayer(m.id);
  }
  for (const o of room.members.values()) if (o.socketId) room.sendEv(o, [{ e: 'left', name: m.name }]);
  room.ensureHost();
  if (!room.connectedHumans().length) room.emptySince = Date.now();
  room.emitRoom();
}

/* ---------------------------------------------------------------------
 *  HTTP + SOCKET.IO
 * ------------------------------------------------------------------- */
loadDb();
const app = express();
app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, players: Object.keys(DB.players).length, uptime: Math.round(process.uptime()) }));
// ===================== App-Icons (PNG, zur Laufzeit gezeichnet) =====================
// Damit keine Bilddateien hochgeladen werden müssen, malt der Server das Icon selbst:
// frech grinsende Alarm-Rundumleuchte mit Signalwellen auf Nachtblau. Ergebnis wird je Größe gecacht.
const ICON_CACHE = new Map();
const CRC_TABELLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABELLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(typ, daten) {
  const len = Buffer.alloc(4); len.writeUInt32BE(daten.length, 0);
  const td = Buffer.concat([Buffer.from(typ, 'ascii'), daten]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function pngKodieren(groesse, rgba) {
  const zeile = groesse * 4 + 1;
  const roh = Buffer.alloc(zeile * groesse);
  for (let y = 0; y < groesse; y++) {
    roh[y * zeile] = 0; // Filter: keiner
    rgba.copy(roh, y * zeile + 1, y * groesse * 4, (y + 1) * groesse * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(groesse, 0); ihdr.writeUInt32BE(groesse, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', require('zlib').deflateSync(roh, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
function iconZeichnen(groesse) {
  const S = groesse;
  const px = 1 / S;                       // ein Pixel in normierten Koordinaten
  const rgba = Buffer.alloc(S * S * 4);
  const klemm = (v, a, b) => (v < a ? a : v > b ? b : v);
  const deck = (d) => klemm(0.5 - d / (px * 1.1), 0, 1); // Kantenglättung aus Abstandsfeld
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const C = {
    nachtOben: hex('#3a1f9a'), nachtUnten: hex('#140a33'), licht: hex('#ffe58a'), welle: hex('#ffd23f'),
    rotHell: hex('#ff7a7a'), rot: hex('#e5243b'), kontur: hex('#1a0f2e'), sockel: hex('#2b1d5c'),
    weiss: hex('#ffffff'), mund: hex('#7a1030'), zunge: hex('#ff8fab'), backe: hex('#ffb3c6'), gelb: hex('#ffd23f')
  };
  const ellipse = (x, y, cx, cy, rx, ry) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
  const box = (x, y, x0, y0, x1, y1, r) => {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
    const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  const strecke = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const t = klemm(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
  };
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const x = (i + 0.5) / S, y = (j + 0.5) / S;
      // Hintergrund: Verlauf + warmer Leuchtschein
      let r = C.nachtOben[0] * (1 - y) + C.nachtUnten[0] * y;
      let g = C.nachtOben[1] * (1 - y) + C.nachtUnten[1] * y;
      let b = C.nachtOben[2] * (1 - y) + C.nachtUnten[2] * y;
      const mische = (farbe, a) => { if (a <= 0) return; r += (farbe[0] - r) * a; g += (farbe[1] - g) * a; b += (farbe[2] - b) * a; };
      const schein = Math.max(0, 1 - Math.hypot(x - 0.5, y - 0.46) / 0.5);
      mische(C.licht, schein * schein * 0.42);
      // Alarm-Signalwellen links und rechts der Leuchte
      const wa = Math.atan2(y - 0.47, x - 0.5);
      const seitlich = Math.abs(Math.sin(wa)) < 0.5;
      if (seitlich) {
        mische(C.welle, deck(Math.abs(Math.hypot(x - 0.5, y - 0.47) - 0.33) - 0.022));
        mische(C.welle, deck(Math.abs(Math.hypot(x - 0.5, y - 0.47) - 0.41) - 0.018) * 0.7);
      }
      // Leuchtkuppel (Halbkreis oben + Rechteck)
      const kuppel = Math.min(Math.hypot(x - 0.5, y - 0.42) - 0.22, box(x, y, 0.28, 0.42, 0.72, 0.72, 0));
      mische(C.kontur, deck(kuppel - 0.02));
      const verlauf = klemm((y - 0.2) / 0.5, 0, 1);
      mische([C.rotHell[0] + (C.rot[0] - C.rotHell[0]) * verlauf, C.rotHell[1] + (C.rot[1] - C.rotHell[1]) * verlauf, C.rotHell[2] + (C.rot[2] - C.rotHell[2]) * verlauf], deck(kuppel));
      // Glanzlicht
      mische(C.weiss, deck(ellipse(x, y, 0.37, 0.32, 0.03, 0.055)) * 0.65);
      // Augenbrauen (verschmitzt schräg)
      mische(C.kontur, deck(strecke(x, y, 0.36, 0.385, 0.45, 0.41) - 0.013));
      mische(C.kontur, deck(strecke(x, y, 0.64, 0.385, 0.55, 0.41) - 0.013));
      // Augen
      for (const ax of [0.425, 0.575]) {
        mische(C.kontur, deck(ellipse(x, y, ax, 0.47, 0.05, 0.058)));
        mische(C.weiss, deck(ellipse(x, y, ax, 0.47, 0.037, 0.045)));
        mische(C.kontur, deck(Math.hypot(x - (ax + 0.016), y - 0.477) - 0.021));
        mische(C.weiss, deck(Math.hypot(x - (ax + 0.022), y - 0.469) - 0.007));
      }
      // Bäckchen
      mische(C.backe, deck(Math.hypot(x - 0.35, y - 0.56) - 0.03) * 0.8);
      mische(C.backe, deck(Math.hypot(x - 0.65, y - 0.555) - 0.03) * 0.8);
      // Grinsen mit Zunge
      const mx = 0.505, my = 0.545, mr = 0.085;
      const imMund = Math.max(Math.hypot(x - mx, y - my) - mr, my + 0.005 - y);
      mische(C.kontur, deck(imMund - 0.013));
      mische(C.mund, deck(imMund));
      mische(C.zunge, deck(Math.max(ellipse(x, y, 0.525, 0.615, 0.042, 0.026), imMund)));
      // Sockel mit gelbem Leuchtstreifen
      const sockel = box(x, y, 0.2, 0.7, 0.8, 0.84, 0.035);
      mische(C.kontur, deck(sockel - 0.012));
      mische(C.sockel, deck(sockel));
      mische(C.gelb, deck(box(x, y, 0.27, 0.75, 0.73, 0.79, 0.02)));
      // Knopf oben
      mische(C.kontur, deck(Math.hypot(x - 0.5, y - 0.19) - 0.042));
      mische(C.gelb, deck(Math.hypot(x - 0.5, y - 0.19) - 0.028));
      const o = (j * S + i) * 4;
      rgba[o] = Math.round(r); rgba[o + 1] = Math.round(g); rgba[o + 2] = Math.round(b); rgba[o + 3] = 255;
    }
  }
  return pngKodieren(S, rgba);
}
const ICON_GROESSEN = [32, 64, 180, 192, 512];
// Beim Start vorzeichnen (dauert ~2 s), damit eine laufende Runde nie durch das Zeichnen ruckelt
for (const g of ICON_GROESSEN) {
  try { ICON_CACHE.set(g, iconZeichnen(g)); } catch (err) { console.error('Icon-Fehler:', err); }
}
app.get(/^\/icon-(\d{2,4})\.png$/, (req, res) => {
  const wunsch = parseInt(req.params[0], 10) || 192;
  // nur vorgezeichnete Größen ausliefern (nächstgrößere), damit niemand den Server mit Riesen-Icons ausbremst
  const groesse = ICON_GROESSEN.find((g) => g >= wunsch) || 512;
  const png = ICON_CACHE.get(groesse);
  if (!png) return res.status(404).end();
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=604800');
  res.send(png);
});
app.get('/favicon.ico', (req, res) => res.redirect(301, '/icon-64.png'));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, file) {
    if (/\.(html|js|css|json)$/i.test(file) || /sw\.js$/i.test(file)) res.setHeader('Cache-Control', 'no-cache');
    if (/sw\.js$/i.test(file)) res.setHeader('Service-Worker-Allowed', '/');
  }
}));
app.get('*', (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/socket.io')) return next();
  const index = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(index)) res.sendFile(index); else res.status(404).send('Streiche Alarm: public/index.html fehlt.');
});

const server = http.createServer(app);
io = new Server(server, { cors: { origin: true }, pingInterval: 10000, pingTimeout: 15000, maxHttpBufferSize: 1e6 });

function handler(socket, ev, fn) {
  socket.on(ev, (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    const reply = safeCb(cb);
    try {
      fn(data && typeof data === 'object' ? data : {}, reply);
    } catch (e) {
      console.error(`[Socket ${ev}]`, e && e.stack);
      reply({ ok: false, msg: 'Interner Fehler – bitte nochmal versuchen.' });
    }
  });
}
function myRoom(socket) { const c = socket.data.roomCode; return c ? rooms.get(c) : null; }
function myPlayer(socket) {
  const room = myRoom(socket);
  if (!room || !room.game) return null;
  const m = room.members.get(socket.data.memberId);
  if (!m || m.socketId !== socket.id || m.spectator) return null;
  return room.game.players.get(m.id) || null;
}
function isHost(socket, room) { return room && room.hostId === socket.data.memberId; }

io.on('connection', (socket) => {
  socket.data = { key: null, code: null, roomCode: null, memberId: null };
  const ip = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').toString().split(',')[0].trim();
  socket.emit('catalog', CATALOG);
  socket.emit('rooms', roomList());

  handler(socket, 'account:register', (d, reply) => {
    const name = normalizeName(d.name);
    if (!name) return reply({ ok: false, msg: 'Der Name braucht 2–16 Zeichen (Buchstaben, Zahlen, Leerzeichen, . _ -).' });
    const code = typeof d.code === 'string' ? d.code.trim() : String(d.code || '');
    const prob = codeProblem(code);
    if (prob) return reply({ ok: false, msg: prob });
    const key = name.toLowerCase();
    let rec = DB.players[key];
    if (rec) {
      if (loginBlocked(ip)) return reply({ ok: false, msg: 'Zu viele Fehlversuche – bitte in ein paar Minuten nochmal.' });
      if (rec.hash !== hashCode(rec.salt, rec.name, code)) {
        loginFailed(ip);
        return reply({ ok: false, msg: 'Diesen Namen gibt es schon. Wähle einen anderen oder lade deinen Spielstand mit dem richtigen Code.' });
      }
    } else {
      rec = newRecord(name, code);
      if (d.avatar) rec.avatar = sanitizeAvatar(d.avatar, rec, rec.avatar);
      if (d.restore) applyRestore(rec, d.restore);
      DB.players[key] = rec;
      ensureDaily(rec);
      saveSoon();
      lbCache = null;
    }
    rec.seen = Date.now();
    socket.data.key = key; socket.data.code = code;
    reply({ ok: true, profile: profileOut(rec, code) });
  });

  handler(socket, 'account:login', (d, reply) => {
    if (loginBlocked(ip)) return reply({ ok: false, msg: 'Zu viele Fehlversuche – bitte in ein paar Minuten nochmal.' });
    const name = normalizeName(d.name);
    const code = typeof d.code === 'string' ? d.code.trim() : String(d.code || '');
    const rec = name ? DB.players[name.toLowerCase()] : null;
    if (!rec || !/^\d{4}$/.test(code) || rec.hash !== hashCode(rec.salt, rec.name, code)) {
      loginFailed(ip);
      return reply({ ok: false, msg: 'Name oder Code stimmt nicht.' });
    }
    rec.seen = Date.now();
    saveSoon();
    socket.data.key = name.toLowerCase(); socket.data.code = code;
    reply({ ok: true, profile: profileOut(rec, code) });
  });

  handler(socket, 'profile:update', (d, reply) => {
    const rec = socket.data.key ? DB.players[socket.data.key] : null;
    if (!rec) return reply({ ok: false, msg: 'Bitte zuerst anmelden.' });
    if (d.avatar) rec.avatar = sanitizeAvatar(d.avatar, rec, rec.avatar);
    if ('perk' in d) {
      if (d.perk === null || d.perk === '') rec.perk = null;
      else if (typeof d.perk === 'string' && PERKS[d.perk] && owns(rec, 'perk:' + d.perk)) rec.perk = d.perk;
      else return reply({ ok: false, msg: 'Dieses Perk hast du noch nicht freigeschaltet.' });
    }
    saveSoon();
    const room = myRoom(socket);
    if (room) {
      const m = room.members.get(socket.data.memberId);
      if (m) {
        m.avatar = rec.avatar;
        const p = room.game && room.game.players.get(m.id);
        if (p && room.state === 'lobby') { p.avatar = rec.avatar; p.perk = rec.perk; }
        room.emitRoom();
      }
    }
    const out = profileOut(rec, socket.data.code);
    socket.emit('profile', out);
    reply({ ok: true, profile: out });
  });

  handler(socket, 'shop:buy', (d, reply) => {
    const rec = socket.data.key ? DB.players[socket.data.key] : null;
    if (!rec) return reply({ ok: false, msg: 'Bitte zuerst anmelden.' });
    const err = shopBuy(rec, String(d.id || ''));
    if (err) return reply({ ok: false, msg: err });
    const room = myRoom(socket);
    if (room && room.state === 'lobby' && room.game) {
      const p = room.game.players.get(socket.data.memberId);
      if (p) { p.slots = rec.slots; p.master = rec.master; }
    }
    const out = profileOut(rec, socket.data.code);
    socket.emit('profile', out);
    reply({ ok: true, profile: out });
  });

  handler(socket, 'leaderboard:get', (d, reply) => reply({ ok: true, list: leaderboard() }));

  handler(socket, 'room:create', (d, reply) => {
    if (!socket.data.key || !DB.players[socket.data.key]) return reply({ ok: false, msg: 'Bitte zuerst anmelden.' });
    leaveRoom(socket, 'neu');
    const room = new Room(newRoomCode());
    rooms.set(room.code, room);
    room.startPractice();
    const err = joinRoom(socket, room);
    if (err) return reply({ ok: false, msg: err });
    room.hostId = socket.data.memberId;
    room.emitRoom();
    reply({ ok: true, code: room.code });
  });

  handler(socket, 'room:join', (d, reply) => {
    if (!socket.data.key || !DB.players[socket.data.key]) return reply({ ok: false, msg: 'Bitte zuerst anmelden.' });
    const code = String(d.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, msg: `Raum „${code || '?'}“ gibt es nicht (mehr).` });
    if (socket.data.roomCode && socket.data.roomCode !== code) leaveRoom(socket, 'wechsel');
    const err = joinRoom(socket, room);
    if (err) return reply({ ok: false, msg: err });
    reply({ ok: true, code: room.code });
  });

  handler(socket, 'room:leave', (d, reply) => {
    leaveRoom(socket, 'verlassen');
    socket.emit('rooms', roomList());
    reply({ ok: true });
  });

  handler(socket, 'room:settings', (d, reply) => {
    const room = myRoom(socket);
    if (!room) return reply({ ok: false, msg: 'Du bist in keinem Raum.' });
    if (!isHost(socket, room)) return reply({ ok: false, msg: 'Nur der Host darf die Einstellungen ändern.' });
    if (room.state === 'playing') return reply({ ok: false, msg: 'Während der Runde geht das nicht.' });
    const s = room.settings;
    const rec = room.hostRec();
    if ('party' in d) s.party = !!d.party;
    if (typeof d.mode === 'string' && MODES[d.mode] && MODES[d.mode].selectable) s.mode = d.mode;
    if (typeof d.building === 'string') {
      if (!BUILDINGS[d.building] || !BUILDINGS[d.building].selectable) return reply({ ok: false, msg: 'Unbekanntes Gebäude.' });
      if (!s.party && !ownsBuilding(rec, d.building)) return reply({ ok: false, msg: `${BUILDINGS[d.building].short} ist noch gesperrt – im Prank-Shop freischalten oder Party-Modus aktivieren.` });
      s.building = d.building;
    }
    if (d.duration === 3 || d.duration === 5 || d.duration === '3' || d.duration === '5') s.duration = parseInt(d.duration, 10);
    if (d.trapRule === 'schnell' || d.trapRule === 'items') s.trapRule = d.trapRule;
    if (!s.party && !ownsBuilding(rec, s.building)) s.building = 'buero';
    room.rebalanceTeams();
    if (room.game && room.state === 'lobby') room.game.party = s.party;
    room.emitRoom();
    reply({ ok: true });
  });

  handler(socket, 'room:bot', (d, reply) => {
    const room = myRoom(socket);
    if (!room) return reply({ ok: false, msg: 'Du bist in keinem Raum.' });
    if (!isHost(socket, room)) return reply({ ok: false, msg: 'Nur der Host darf Bots verwalten.' });
    if (room.state === 'playing') return reply({ ok: false, msg: 'Während der Runde geht das nicht.' });
    if (d.action === 'add') { if (!room.addBot()) return reply({ ok: false, msg: 'Maximal 6 Teilnehmer.' }); }
    else if (d.action === 'remove') { if (!room.removeBot()) return reply({ ok: false, msg: 'Kein Bot zum Entfernen da.' }); room.rebalanceTeams(); }
    else return reply({ ok: false, msg: 'Unbekannte Aktion.' });
    room.emitRoom();
    reply({ ok: true });
  });

  handler(socket, 'room:team', (d, reply) => {
    const room = myRoom(socket);
    if (!room) return reply({ ok: false, msg: 'Du bist in keinem Raum.' });
    if (!isHost(socket, room)) return reply({ ok: false, msg: 'Nur der Host darf Teams einteilen.' });
    if (room.state === 'playing') return reply({ ok: false, msg: 'Während der Runde geht das nicht.' });
    const m = room.members.get(String(d.id || ''));
    if (!m) return reply({ ok: false, msg: 'Spieler nicht gefunden.' });
    if (d.team !== 0 && d.team !== 1) return reply({ ok: false, msg: 'Team muss 0 oder 1 sein.' });
    m.team = d.team;
    room.emitRoom();
    reply({ ok: true });
  });

  handler(socket, 'room:start', (d, reply) => {
    const room = myRoom(socket);
    if (!room) return reply({ ok: false, msg: 'Du bist in keinem Raum.' });
    if (!isHost(socket, room)) return reply({ ok: false, msg: 'Nur der Host kann die Runde starten.' });
    if (room.state === 'playing') return reply({ ok: false, msg: 'Die Runde läuft schon.' });
    const err = room.start();
    if (err) return reply({ ok: false, msg: err });
    reply({ ok: true });
  });

  handler(socket, 'room:again', (d, reply) => {
    const room = myRoom(socket);
    if (!room) return reply({ ok: false, msg: 'Du bist in keinem Raum.' });
    if (!isHost(socket, room)) return reply({ ok: false, msg: 'Nur der Host kann zurück in die Lobby.' });
    if (room.state !== 'results') return reply({ ok: false, msg: 'Gerade gibt es kein Ergebnis.' });
    room.backToLobby();
    reply({ ok: true });
  });

  handler(socket, 'input', (d) => {
    const p = myPlayer(socket);
    if (!p || p.ai) return;
    let x = Number(d.x), y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    p.input = { x, y };
    if (l > 0.3) {
      p.path = null; p.pathThen = null;
      const game = myRoom(socket).game;
      if (p.hidden) { p.hidden = null; game.queue(p.id, { e: 'hide', on: false }); }
      if (p.build || p.use) game.cancelAction(p, p.build ? 'Falle abgebrochen.' : null);
    }
  });

  handler(socket, 'moveTo', (d) => {
    const p = myPlayer(socket);
    if (!p || p.ai) return;
    const then = d.then === 'use' || d.then === 'hide' ? d.then : null;
    myRoom(socket).game.moveTo(p, Number(d.x), Number(d.y), then);
  });

  handler(socket, 'act', (d, reply) => {
    const p = myPlayer(socket);
    if (!p) return reply({ ok: false, msg: 'Du spielst gerade nicht.' });
    const game = myRoom(socket).game;
    if (game.over) return reply({ ok: false, msg: 'Die Runde ist vorbei.' });
    switch (d.type) {
      case 'use': game.doUse(p); return reply({ ok: true });
      case 'wheel': return reply(game.wheelOptions(p, typeof d.dev === 'string' ? d.dev : null));
      case 'trap': game.actTrap(p, String(d.dev || ''), d.slot); return reply({ ok: true });
      case 'cancel': game.cancelAction(p, null); return reply({ ok: true });
      case 'hide': game.doHide(p); return reply({ ok: true });
      case 'disguise': game.doDisguise(p); return reply({ ok: true });
      case 'wave': game.doWave(p); return reply({ ok: true });
      case 'emoji': game.doEmoji(p, String(d.e || '')); return reply({ ok: true });
      default: return reply({ ok: false, msg: 'Unbekannte Aktion.' });
    }
  });

  socket.on('disconnect', () => {
    try { leaveRoom(socket, 'getrennt'); } catch (e) { console.error('[disconnect]', e && e.stack); }
  });
});

/* Spielschleife: 20 Hz */
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.game) continue;
    try {
      if (room.state === 'lobby' || room.state === 'playing') room.game.step(DT);
      room.game.flush(io);
    } catch (e) {
      console.error(`[Raum ${room.code}] Fehler in der Spielschleife:`, e && e.stack);
    }
  }
}, 1000 / TICK_RATE);

/* Raumliste & Aufräumen */
setInterval(() => {
  try {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (!room.connectedHumans().length) {
        if (!room.emptySince) room.emptySince = now;
        if (now - room.emptySince > 30000) {
          if (room.resultsTimer) clearTimeout(room.resultsTimer);
          rooms.delete(code);
          roomsDirty = true;
        }
      }
    }
    if (roomsDirty) {
      roomsDirty = false;
      const list = roomList();
      for (const s of io.sockets.sockets.values()) if (!s.data.roomCode) s.emit('rooms', list);
    }
    for (const [ip, f] of loginFails) if (now - f.first > 10 * 60 * 1000) loginFails.delete(ip);
  } catch (e) {
    console.error('[Aufräumen]', e && e.stack);
  }
}, 1000);

function shutdown() {
  console.log('[Server] Beende – speichere Spielstände …');
  dirty = true;
  saveDbNow();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => console.error('[Unerwarteter Fehler]', e && e.stack));
process.on('unhandledRejection', (e) => console.error('[Unbehandelte Promise]', e));

if (require.main === module) {
  server.listen(PORT, () => console.log(`🎭 Streiche Alarm läuft auf Port ${PORT} (Daten: ${DATA_DIR})`));
}

module.exports = { generateMap, codeProblem, CATALOG, server, rooms, Game, Room, GameMap, DB, T_FLOOR, T_WALL, T_DOOR, T_EXIT, T_VOID };
