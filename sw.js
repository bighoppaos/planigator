const CACHE = "planigator-web-v16";
const ASSETS = [
  "./",
  "./index.html",
  "./plan.html",
  "./support.html",
  "./privacy.html",
  "./terms.html",
  "./404.html",
  "./styles.css",
  "./favicon.svg",
  "./icons/PlanigatorIcon.png",
  "./manifest.json",
  "./js/app.js",
  "./js/hos.js",
  "./js/plan.js",
  "./js/here.js",
  "./js/api.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== "GET") return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      const updating = fetch(event.request).then((response) => {
        if (response && response.ok) cache.put(event.request, response.clone());
        return response;
      }).catch(() => null);
      if (cached) return cached;
      return (await updating) || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
    })
  );
});
