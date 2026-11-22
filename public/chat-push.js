self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {}
  const url = data.url || (data.roomId ? '/?chat=' + encodeURIComponent(data.roomId) : '/');
  event.waitUntil(
    self.registration.showNotification(data.title || 'Позитив Вектор', {
      body: data.body || 'Новое уведомление',
      icon: '/pwa-192x192.png',
      tag: data.tag || undefined,
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    (async () => {
      const fullUrl = new URL(targetUrl, self.location.origin).href;
      const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        if ('focus' in client) {
          if ('navigate' in client && client.url !== fullUrl) {
            try {
              await client.navigate(fullUrl);
            } catch {}
          } else {
            client.postMessage({ type: 'pv:navigate', url: targetUrl });
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(fullUrl);
      }
      return undefined;
    })()
  );
});
