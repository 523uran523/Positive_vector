import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

let updatePending = false;
let announceUpdate = () => {};
const updateSW = registerSW({ immediate: true, onNeedRefresh: () => { updatePending = true; announceUpdate(); } });

function Application() {
  const [updateAvailable, setUpdateAvailable] = useState(updatePending);
  announceUpdate = () => setUpdateAvailable(true);
  return <>
    {updateAvailable && <div role="status" className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-blue-700 p-3 text-sm text-white">
      Доступна новая версия приложения.
      <button type="button" className="rounded bg-white px-3 py-1 font-semibold text-blue-700" onClick={() => void updateSW(true)}>Обновить</button>
      <button type="button" onClick={() => setUpdateAvailable(false)}>Позже</button>
    </div>}
    <App />
  </>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Application />
  </StrictMode>
);
