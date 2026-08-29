const CACHE_NAME = 'minfin-cache-v1';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(['./', './index.html', './app.js', './styles.css']))
  );
});

self.addEventListener('fetch', e => {
  // Ignoramos la caché para la API del backend en Google Apps Script
  if (e.request.url.includes('script.google.com')) return;
  
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});