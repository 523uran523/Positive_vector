import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
const projectRoot=path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
  const disableHmr = process.env.DISABLE_HMR === 'true' || Boolean(process.env.K_SERVICE);
  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(disableHmr
        ? [
            {
              name: 'disable-vite-hmr-websocket',
              enforce: 'post' as const,
              transform(code: string, id: string) {
                if (!id.replace(/\\/g, '/').endsWith('/vite/dist/client/client.mjs')) return null;
                return code.replace(
                  'const createWebSocketModuleRunnerTransport = (options) => {',
                  'const createWebSocketModuleRunnerTransport = () => ({ async connect() {}, disconnect() {}, send() {} });\nconst _unusedCreateWebSocketModuleRunnerTransport = (options) => {'
                );
              },
            },
          ]
        : []),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png'],
        manifest: {
          id: '/',
          name: 'Позитив Вектор — CRM/ERP',
          short_name: 'Позитив',
          description: 'CRM/ERP-система для изготовления и монтажа рекламных баннеров, декораций и конструкций.',
          theme_color: '#0071E3',
          background_color: '#F5F5F7',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          lang: 'ru',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          importScripts: ['/chat-push.js'],
          cleanupOutdatedCaches: true,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            { urlPattern: /\/api\//, handler: 'NetworkOnly' },
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: !disableHmr,
          type: 'module',
        },
      }),
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) return;
          const distDir = path.resolve(projectRoot, 'dist');
          const srcAssets = path.resolve(projectRoot, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, { recursive: true, force: true });
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(projectRoot, '.'),
      },
    },
    server: {
      ws: disableHmr ? (false as const) : undefined,
      hmr: !disableHmr,
      watch: disableHmr ? null : {},
    },
  };
});
