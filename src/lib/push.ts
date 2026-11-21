import { apiRequest } from './api';

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

export async function enablePushNotifications(): Promise<{ ok: true }> {
  if (!window.isSecureContext) {
    throw new Error('Push-уведомления работают только по защищённому соединению HTTPS.');
  }
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('На этом устройстве push-уведомления недоступны. На iPhone добавьте приложение на экран «Домой».');
  }

  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Разрешение на уведомления не выдано в настройках браузера.');
  }

  const { publicKey } = await apiRequest<{ publicKey: string | null }>('/api/push/key', {
    useCache: false,
  });
  if (!publicKey) {
    throw new Error('Push-уведомления ещё не настроены на сервере.');
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await apiRequest('/api/push/subscription', {
    method: 'POST',
    body: subscription.toJSON(),
    skipOfflineQueue: true,
  });

  return { ok: true };
}
