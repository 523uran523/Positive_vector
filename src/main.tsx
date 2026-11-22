import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => {
    void updateSW(true);
  },
  onRegisteredSW: (_swUrl, reg) => {
    if (!reg) return;
    window.setInterval(() => {
      void reg.update().catch(() => {});
    }, 30 * 60 * 1000);
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
