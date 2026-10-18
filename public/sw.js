// Offline support. Hashed build assets never change: cache first.
// The page itself: network first, so a new version is picked up when online.
// The page has one cache per app version (it registers sw.js?v=<version>), replaced by the next.
// Hashed assets live in a cache of their own that versions share: an update only downloads the
// files that changed, not the 20 MB geometry kernel again. A file's older builds are dropped when
// a new one is stored.
const CACHE = "waffle-" + (new URL(location.href).searchParams.get("v") || "dev");
const ASSETS = "waffle-assets";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const assets = await caches.open(ASSETS);
      for (const k of await caches.keys()) {
        if (k === CACHE || k === ASSETS) continue;
        // Caches of earlier versions also held assets: keep them (the kernel above all) before
        // dropping the rest.
        const old = await caches.open(k);
        for (const req of await old.keys())
          if (new URL(req.url).pathname.includes("/assets/") && !(await assets.match(req))) {
            const res = await old.match(req);
            if (res) await assets.put(req, res);
          }
        await caches.delete(k);
      }
      await self.clients.claim();
    })(),
  );
});

/** "index-DI4Gxkts.js" → "index.js": the same file across builds. */
const stem = (url) => new URL(url).pathname.replace(/-[\w-]{8}(\.\w+)$/, "$1");

async function storeAsset(cache, req, res) {
  const s = stem(req.url);
  for (const old of await cache.keys()) if (old.url !== req.url && stem(old.url) === s) await cache.delete(old);
  await cache.put(req, res);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const isPage = req.mode === "navigate";
  const isAsset = new URL(req.url).pathname.includes("/assets/");
  e.respondWith(
    (async () => {
      const cache = await caches.open(isAsset ? ASSETS : CACHE);
      if (isAsset) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      try {
        // "reload" bypasses the HTTP cache, which could hand back a stale page.
        const res = await fetch(req, isPage ? { cache: "reload" } : undefined);
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(isAsset ? storeAsset(cache, req, copy) : cache.put(req, copy));
        }
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: isPage });
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
