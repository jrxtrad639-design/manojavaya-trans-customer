const CACHE = "manojavaya-customer-v1.1.4-ready-1";
const APP = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/manojavaya-logo-circle-192.png",
  "./assets/manojavaya-logo-circle-512.png",
  "./assets/apple-touch-icon-180.png",
  "./assets/favicon-32.png",
  "./assets/favicon-48.png"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Never cache the booking API.
  event.respondWith(
    fetch(request).then(response => {
      if (response && response.ok) caches.open(CACHE).then(c => c.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request).then(cached => cached || caches.match("./index.html")))
  );
});
