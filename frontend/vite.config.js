import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Split React out of the app chunk. It barely changes between deploys,
        // so giving it its own content-hashed file lets returning users reuse it
        // from cache instead of re-downloading it every time the app code
        // changes. (xlsx already gets its own chunk — it's behind a dynamic
        // import in App.jsx — so it doesn't need listing here.)
        manualChunks: {
          react: ["react", "react-dom"],
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Fee Ledger",
        short_name: "Fee Ledger",
        description: "School fee, transport, and expense management",
        theme_color: "#00545F",
        background_color: "#ECFFB6",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Keep the spreadsheet library out of the precache. Otherwise the service
        // worker downloads all ~430kB of it on install (and again on every deploy)
        // for a feature most sessions never touch — which would undo the dynamic
        // import in App.jsx for exactly the PWA users it's meant to help. It's
        // cached at runtime instead, the first time someone actually exports.
        globIgnores: ["**/xlsx-*.js"],
        runtimeCaching: [
          {
            // Fee/payment data must never be served stale from a cache, so every
            // /api/ request always goes straight to the network — the service
            // worker only ever caches the built JS/CSS/icons (the "app shell"),
            // never the live data itself.
            // Matched without a leading ^: workbox tests this against the request's
            // full URL (https://host/api/...), so an anchored /^\/api\// could
            // never match and the rule silently did nothing.
            urlPattern: /\/api\//,
            handler: "NetworkOnly",
          },
          {
            // The lazily-loaded xlsx chunk: fetched on first export, then served
            // from cache. Content-hashed filename, so a new build fetches a new
            // entry rather than serving a stale one.
            urlPattern: /\/assets\/xlsx-.*\.js$/,
            handler: "CacheFirst",
            options: {
              cacheName: "xlsx-lib",
              expiration: { maxEntries: 2 },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
