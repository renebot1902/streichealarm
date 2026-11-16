/* Streiche Alarm – Service Worker
   Strategie: "Netzwerk zuerst, Cache als Rückfall".
   So kommen neue Versionen nach jedem Deploy sofort an, und die App startet trotzdem,
   wenn das Netz kurz weg ist. Echtzeit-Verbindungen (/socket.io/) werden nie angefasst. */

const CACHE = 'streiche-alarm-v1';
const KERN_DATEIEN = [
  '/',
  '/index.html',
  '/style.css',
  '/game.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(KERN_DATEIEN.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

function offlineSeite() {
  const html = '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>Streiche Alarm – offline</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#1b1140;color:#fff;font-family:system-ui,sans-serif;text-align:center;padding:24px}' +
    'button{margin-top:18px;font-size:18px;padding:12px 22px;border-radius:14px;border:3px solid #000;' +
    'background:#ffd23f;font-weight:700}</style></head><body><div>' +
    '<div style="font-size:64px">💡</div><h1>Keine Verbindung</h1>' +
    '<p>Streiche Alarm braucht Internet, damit du mit deinen Freunden spielen kannst.</p>' +
    '<button onclick="location.reload()">Nochmal versuchen</button></div></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Google Fonts etc. direkt vom Netz
  if (url.pathname.startsWith('/socket.io/')) return;         // Echtzeit nie cachen
  if (url.pathname === '/health') return;

  event.respondWith(
    fetch(req)
      .then((antwort) => {
        if (antwort && antwort.ok && antwort.type === 'basic') {
          const kopie = antwort.clone();
          caches.open(CACHE).then((cache) => cache.put(req, kopie)).catch(() => null);
        }
        return antwort;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((treffer) => {
          if (treffer) return treffer;
          if (req.mode === 'navigate') {
            return caches.match('/index.html').then((idx) => idx || offlineSeite());
          }
          return new Response('', { status: 504, statusText: 'Offline' });
        })
      )
  );
});
