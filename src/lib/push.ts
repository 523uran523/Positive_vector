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

export async function isPushNotificationsEnabled(): Promise<boolean> {
  if (
    typeof window === 'undefined' ||
    !window.isSecureContext ||
    !('Notification' in window) ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    Notification.permission !== 'granted'
  ) {
    return false;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;
  const subscription = await registration.pushManager.getSubscription();
  return Boolean(subscription);
}

export async function disablePushNotifications(): Promise<{ ok: true }> {
  let endpoint: string | undefined;
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      endpoint = subscription.endpoint;
      await subscription.unsubscribe().catch(() => false);
    }
  }
  await apiRequest('/api/push/subscription', {
    method: 'DELETE',
    body: endpoint ? { endpoint } : {},
    skipOfflineQueue: true,
  });
  return { ok: true };
}

