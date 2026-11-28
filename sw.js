const CACHE_NAME = 'modular-pwa-base-v34';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './styles/main.css',
  './styles/v27-layout.css',
  './src/main.js',
  './src/data/default-dialogues.js',
  './src/data/shop-catalog.js',
  './src/core/event-bus.js',
  './src/core/storage.js',
  './src/core/api.js',
  './src/core/module-manager.js',
  './src/core/save-manager.js',
  './src/core/calc-engine.js',
  './src/core/entity-system.js',
  './src/core/rule-engine.js',
  './src/core/state-machine.js',
  './src/core/prompt-pipeline.js',
  './src/core/asset-manager.js',
  './src/core/ui-kit.js',
  './src/core/stat-rules.js',
  './src/core/inventory-system.js',
  './src/core/resource-manager.js',
  './src/core/log-system.js',
  './src/core/fx-stage.js',
  './src/core/route-generator.js',
  './src/core/tactical-combat.js',
  './src/core/commander-system.js',
  './src/core/formation-system.js',
  './src/core/expedition-system.js',
  './src/core/port-buildings.js',
  './src/core/interaction-system.js',
  './src/core/content-manager.js',
  './src/core/story-pack-engine.js',
  './src/core/story-engine.js',
  './src/core/theme-manager.js',
  './src/core/personality-pool.js',
  './src/core/dialogue-engine.js',
  './src/modules/index.js',
  './src/modules/title-screen.js',
  './src/modules/port-hub.js',
  './src/modules/port-facilities.js',
  './src/modules/facilities-hub.js',
  './src/modules/custom-workshop.js',
  './src/modules/battle-screen.js',
  './src/modules/sortie-console.js',
  './src/modules/character-console.js',
  './src/modules/supply-workshop.js',
  './src/modules/compendium-studio.js',
  './src/modules/action-console.js',
  './src/modules/framework-lab.js',
  './src/modules/ai-console.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never intercept cross-origin requests (e.g. Gemini / OpenAI API endpoints)
  if (url.origin !== self.location.origin) return;

  // Network-first with cache fallback for fresh updates + reliable offline support
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        })
      )
  );
});
