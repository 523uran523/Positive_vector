self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || 'Общий чат', {
    body: data.body || 'Новое сообщение', icon: '/pwa-192x192.png', data: { url: '/?chat=' + encodeURIComponent(data.roomId || 'general') },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/?chat=1'));
});
