import { getCsrfToken, setCsrfToken } from './apiTransport';

export class UploadError extends Error {
  status?: number;
  retryable: boolean;

  constructor(message: string, options: { status?: number; retryable: boolean } = { retryable: false }) {
    super(message);
    this.name = 'UploadError';
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

export interface UploadWithRetryOptions {
  url: string;
  formData: FormData;
  attempts?: number;
  retryDelayMs?: number;
  onProgress?: (percent: number) => void;
}

async function resolveCsrfToken(): Promise<string | null> {
  const cached = getCsrfToken();
  if (cached) return cached;
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { csrfToken?: string | null };
    if (data?.csrfToken) {
      setCsrfToken(data.csrfToken);
      return data.csrfToken;
    }
  } catch {
    // Let XHR attempt fail cleanly if offline.
  }
  return null;
}

function sendXhrOnce<T>(
  url: string,
  formData: FormData,
  csrfToken: string | null,
  onProgress?: (percent: number) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.timeout = 0;
    if (csrfToken) {
      xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0 && onProgress) {
        const pct = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
        onProgress(pct);
      }
    };

    xhr.onload = () => {
      let data: any = null;
      const contentType = xhr.getResponseHeader('content-type') || '';
      if (contentType.includes('application/json') && xhr.responseText) {
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve(data as T);
        return;
      }

      if (xhr.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('pv:unauthorized'));
      }

      const message = data?.error || `Ошибка загрузки (${xhr.status})`;
      const retryable = xhr.status === 0 || xhr.status >= 500 || xhr.status === 429;
      reject(new UploadError(message, { status: xhr.status, retryable }));
    };

    xhr.onerror = () => {
      reject(new UploadError('Сбой соединения при передаче файла.', { retryable: true }));
    };

    xhr.onabort = () => {
      reject(new UploadError('Загрузка файла прервана.', { retryable: false }));
    };

    xhr.ontimeout = () => {
      reject(new UploadError('Превышено время ожидания передачи файла.', { retryable: true }));
    };

    xhr.send(formData);
  });
}

export async function uploadWithRetry<T = unknown>({
  url,
  formData,
  attempts = 3,
  retryDelayMs = 400,
  onProgress,
}: UploadWithRetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, attempts);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const csrfToken = await resolveCsrfToken();
      return await sendXhrOnce<T>(url, formData, csrfToken, onProgress);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof UploadError ? err.retryable : true;
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      onProgress?.(0);
      await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new UploadError('Не удалось загрузить файл.', { retryable: false });
}
