import { Download } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export function PWAInstallButton({ compact = false }: { compact?: boolean }) {
  const { isInstallable, promptInstall } = usePWAInstall();
  if (!isInstallable) return null;

  return (
    <button
      type="button"
      onClick={() => void promptInstall()}
      className="inline-flex items-center gap-2 rounded-xl bg-[#0071E3] px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#0077ED] active:scale-[0.98] dark:bg-[#2997FF] dark:text-[#0B0C10]"
      title="Установить «Позитив Вектор» как приложение"
    >
      <Download className="h-3.5 w-3.5" />
      <span>{compact ? 'Установить' : 'Установить приложение'}</span>
    </button>
  );
}
