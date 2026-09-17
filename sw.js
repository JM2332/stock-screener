// Forces the page shell (index.html) to always be re-fetched from the network,
// bypassing GitHub Pages' Cache-Control: max-age=600 on the HTML document.
// app.js/style.css are already cache-busted via ?v= query strings in index.html,
// so this only needs to handle navigation/HTML requests.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const isHtml = e.request.mode === 'navigate' ||
    (e.request.method === 'GET' && (e.request.headers.get('accept') || '').includes('text/html'));
  if (!isHtml) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Price alert', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Price alert', {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const c of clientList) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
