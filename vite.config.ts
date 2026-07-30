import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      // The service worker is hand-written (src/sw.ts) because the share_target
      // POST handler can't be expressed by generateSW.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'favicon-32.png', 'icons/*.png', 'fonts/*'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      manifest: {
        name: 'Milkbox',
        short_name: 'Milkbox',
        description: 'A chat with yourself. Drop text, links, and files; they land on every device.',
        theme_color: '#e8e4dd',
        background_color: '#faf8f4',
        display: 'standalone',
        display_override: ['window-controls-overlay'],
        start_url: '/',
        orientation: 'any',
        categories: ['productivity', 'utilities'],
        launch_handler: {
          client_mode: 'navigate-existing',
        },
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: ['image/*', 'video/*', 'audio/*', 'application/pdf', 'text/*'],
              },
            ],
          },
        },
        icons: [
          { src: 'icons/icon-48.png', sizes: '48x48', type: 'image/png' },
          { src: 'icons/icon-128.png', sizes: '128x128', type: 'image/png' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
