const APP_VERSION = "2026.10.25.1";
const CACHE_PREFIX = "musime-static-";
const CACHE_NAME = `${CACHE_PREFIX}v27-${APP_VERSION}`;
const STATIC_ASSETS = [
  "./", "./index.html", `./styles.css?v=${APP_VERSION}`, `./app.js?v=${APP_VERSION}`, `./search-engine.js?v=${APP_VERSION}`,
  "./manifest.webmanifest", "./icons/icon-192.svg", "./icons/icon-512.svg",
  "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png"
];
const ASSET_URLS = new Set(STATIC_ASSETS.map((path) => new URL(path, self.registration.scope).href));

// Activate a release only after its complete shell is downloaded successfully.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(STATIC_ASSETS.map(async (path) => {
      const url = new URL(path, self.registration.scope);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url.href, { cache: "reload", signal: controller.signal });
        if (!response.ok) throw new Error(`Shell asset unavailable: ${url.pathname}`);
        const type = response.headers.get("content-type") || "";
        if (url.pathname.endsWith(".js") && !/javascript/i.test(type)) throw new Error("Invalid script response");
        if (url.pathname.endsWith(".css") && !/text\/css/i.test(type)) throw new Error("Invalid stylesheet response");
        await cache.put(url.href, response);
      } finally { clearTimeout(timer); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "GET_VERSION") event.source?.postMessage({ type: "MUSIME_VERSION", version: APP_VERSION });
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const navigation = event.request.mode === "navigate";
  if (!navigation && !ASSET_URLS.has(url.href)) return;

  // Pin HTML, JS, and CSS to one complete release. Updates arrive through the
  // service-worker lifecycle, instead of mixing old HTML with new scripts.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(navigation ? new URL("./index.html", self.registration.scope).href : event.request);
    if (cached) return cached;
    return fetch(event.request);
  })());
});
