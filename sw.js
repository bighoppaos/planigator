const CACHE = "planigator-web-v5";
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
  "./js/here-key.js",
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
  if (url.origin !== location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
