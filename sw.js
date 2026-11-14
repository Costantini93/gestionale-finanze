// Service worker: salva l'app sul dispositivo così funziona anche senza connessione.
// Quando modifichi i file dell'app, aumenta VERSION per far scaricare la nuova versione.
const VERSION = 'v33';
const CACHE = 'abbonamenti-' + VERSION;
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css', 'css/theme.css',
  'fonts/bricolage-grotesque.woff2', 'fonts/hanken-grotesk.woff2',
  'js/vault.js', 'js/services.js', 'js/categories.js', 'js/parser.js', 'js/detector.js', 'js/app.js',
  'lib/xlsx.full.min.js', 'lib/pdf.min.js', 'lib/pdf.worker.min.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Prima la rete (così gli aggiornamenti arrivano subito), poi la copia salvata se si è offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
