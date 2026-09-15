import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['icons/*.svg', 'icons/*.png'],
      manifest: {
        name: 'Goon Drop',
        short_name: 'Goon Drop',
        description: 'Local continuity ecosystem – clipboard sync, file sharing, link handoff between Windows and iPhone',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        categories: ['utilities', 'networking', 'productivity'],
        iarc_rating_id: 'e8c8d8e6-8b7b-4f8a-9a0a-5c0a0a0a0a0a',
        screenshots: [],
        prefer_related_applications: false,
        share_target: {
          action: '/?share=true',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: ['image/*', 'video/*', 'audio/*', 'application/*', 'text/*', '/*'],
              },
            ],
          },
        },
        shortcuts: [
          {
            name: 'Dashboard',
            short_name: 'Dashboard',
            url: '/?tab=dashboard',
            icons: [{ src: '/icons/icon-192.svg', sizes: '192x192' }]
          },
          {
            name: 'Clipboard Sync',
            short_name: 'Clipboard',
            url: '/?tab=clipboard',
            icons: [{ src: '/icons/icon-192.svg', sizes: '192x192' }]
          },
          {
            name: 'File Share',
            short_name: 'Files',
            url: '/?tab=files',
            icons: [{ src: '/icons/icon-192.svg', sizes: '192x192' }]
          },
          {
            name: 'Link Handoff',
            short_name: 'Links',
            url: '/?tab=links',
            icons: [{ src: '/icons/icon-192.svg', sizes: '192x192' }]
          }
        ],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/icon-192-maskable.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'maskable' },
          { src: '/icons/icon-512-maskable.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
        runtimeCaching: [
          {
            // ⚠️ CRITICAL OFFLINE FILE VAULT CACHING: Store shared files natively on phone storage so they can be saved/opened completely offline!
            urlPattern: /^\/api\/files\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'goondrop-file-vault',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 86400 * 30 // Keep files cached for up to 30 Days!
              }
            }
          },
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
            options: { backgroundSync: { name: 'Goon Drop-sync' } },
          },
          {
            urlPattern: /^https?:\/\/.*\/ws\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3941', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3941', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
})
