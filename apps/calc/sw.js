const CACHE = 'calc-v2';
const ASSETS = [
  './calc.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Firebase CDN はネット必須なのでキャッシュに触らない
  if (url.includes('gstatic.com') || url.includes('firestore') || url.includes('googleapis')) return;

  // HTML（画面遷移・calc.html）は常に最新を取りに行く（network-first）。
  // オフライン時のみキャッシュにフォールバックする。
  if (e.request.mode === 'navigate' || url.includes('calc.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // アイコン等の静的アセットは cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
