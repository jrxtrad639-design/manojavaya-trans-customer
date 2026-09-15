const CACHE = "manojavaya-customer-v1.1.7";
const API = "https://manojavaya-trans-api.manojavayatrans.workers.dev";

const APP = [
  "./",
  "./index.html",
  "./manifest.webmanifest"
];

const BOOKING_PATCH = `
<script>
(function () {
  const nativeFetch = window.fetch.bind(window);
  const API_ORIGIN = "https://manojavaya-trans-api.manojavayatrans.workers.dev";

  window.fetch = async function (input, init) {
    const url =
      typeof input === "string"
        ? input
        : (input && input.url) || "";

    const method =
      ((init && init.method) ||
       (input && input.method) ||
       "GET").toUpperCase();

    if (
      url.indexOf(API_ORIGIN + "/api/booking-requests") === 0 &&
      method === "POST"
    ) {
      const body =
        init && init.body != null
          ? String(init.body)
          : "";

      await nativeFetch(url, {
        method: "POST",
        mode: "no-cors",
        cache: "no-store",
        body
      });

      return new Response(
        JSON.stringify({
          ok: true,
          transport: "opaque-post"
        }),
        {
          status: 201,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    return nativeFetch(input, init);
  };
})();
</script>`;

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(async response => {

        if (
          url.pathname.endsWith("/index.html") ||
          url.pathname === "/manojavaya-trans-customer/"
        ) {
          try {
            const html = await response.text();

            const patched = html.includes("</body>")
              ? html.replace(
                  "</body>",
                  BOOKING_PATCH + "</body>"
                )
              : html + BOOKING_PATCH;

            const patchedResponse = new Response(
              patched,
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
              }
            );

            if (patchedResponse.ok) {
              caches.open(CACHE)
                .then(cache =>
                  cache.put(
                    request,
                    patchedResponse.clone()
                  )
                );
            }

            return patchedResponse;

          } catch (_) {}
        }

        if (response && response.ok) {
          caches.open(CACHE)
            .then(cache =>
              cache.put(
                request,
                response.clone()
              )
            );
        }

        return response;

      })
      .catch(() =>
        caches.match(request)
          .then(
            cached =>
              cached ||
              caches.match("./index.html")
          )
      )
  );
});
