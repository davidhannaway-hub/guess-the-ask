/* Guess the Ask service worker: push notifications only. It caches nothing, so the live site is never stale. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
// An empty fetch handler keeps older browsers treating the site as installable; it caches nothing.
self.addEventListener('fetch', () => {});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  const title = d.title || 'Guess the Ask';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "Today's houses are live.",
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || 'gta-daily',
    renotify: false,
    data: { url: d.url || '/?s=push' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/?s=push';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
