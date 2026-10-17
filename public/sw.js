// Offline support. Hashed build assets never change: cache first.
// The page itself: network first, so a new version is picked up when online.
// One cache per app version (the page registers sw.js?v=<version>): a new version replaces it.
const CACHE = "waffle-" + (new URL(location.href).searchParams.get("v") || "dev");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const isPage = req.mode === "navigate";
  const isAsset = new URL(req.url).pathname.includes("/assets/");
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isAsset) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      try {
        // "reload" bypasses the HTTP cache, which could hand back a stale page.
        const res = await fetch(req, isPage ? { cache: "reload" } : undefined);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: isPage });
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
