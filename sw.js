// DevVerse Service Worker
// IMPORTANT: bump CACHE_NAME on every deploy that changes cached files. The old
// cache name is what the activate handler uses to detect and purge stale caches
// — if this string never changes, old cached pages/assets can keep being served
// indefinitely on devices where the service worker stays alive across sessions.
const CACHE_NAME = "devverse-v2";
const APP_SHELL = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Always try the network first for everything. Only fall back to cache when
// truly offline (fetch throws). This trades a little offline resilience for
// guaranteeing that logged-in users always see the latest deployed code —
// important for a fast-moving app where stale cached JS can silently break
// features that depend on matching frontend/backend versions.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && req.url.startsWith(self.location.origin)) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// ---------- Push notifications ----------
self.addEventListener("push", (event) => {
  let data = { title: "DevVerse", body: "لديك رسالة جديدة", url: "/", tag: "devverse" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // fall back to defaults if payload isn't valid JSON
  }

  const options = {
    body: data.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag,
    data: { url: data.url },
    dir: "rtl",
    lang: "ar",
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
