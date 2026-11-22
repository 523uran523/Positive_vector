export function getTelHref(phone?: string | null): string {
  if (!phone) return '';
  const cleaned = phone.trim().replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  return digits.length >= 5 ? `tel:${cleaned}` : '';
}

export function getMapHref(address?: string | null): string {
  const trimmed = (address || '').trim();
  if (!trimmed) return '';
  return `https://yandex.ru/maps/?text=${encodeURIComponent(trimmed)}`;
}

export function toLocalDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
