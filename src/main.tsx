import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Автоматическое обновление service worker при обнаружении новой версии.
// При обновлении очищает старые кэши и перезагружает страницу.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // Немедленно применяем обновление без запроса пользователя
    void updateSW(true);
  },
  onRegisteredSW(swUrl) {
    // Периодическая проверка обновлений каждые 30 минут
    setInterval(() => {
      fetch(swUrl, { cache: 'no-store' }).catch(() => {});
    }, 30 * 60 * 1000);
  },
});

function Application() {
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Application />
  </StrictMode>
);