self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}
  const roomId = data.roomId || 'general';
  const target = data.url || ('/?chat=' + encodeURIComponent(roomId));
  const tag = data.tag || ('chat:' + roomId);
  event.waitUntil(
    self.registration.showNotification(data.title || 'Общий чат', {
      body: data.body || 'Новое сообщение',
      icon: '/pwa-192x192.png',
      tag,
      data: { url: target },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate?.(target);
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});