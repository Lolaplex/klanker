// Klanker PWA shell. Precaches the app shell only; /v1/* and /health are
// auth/live data and must never touch the cache.
const CACHE = "klanker-shell-v11";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/klanker.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/v1/") || url.pathname === "/health") {
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }
  // Hashed /assets/* are immutable: serve cache instantly, revalidate in
  // background so a poisoned or stale entry self-heals on next load.
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const refresh = fetch(event.request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
      return hit || refresh;
    })
  );
});

// Web Push (VAPID). Payload contract with the relay: JSON
// { title, body, tag?, url? } — url defaults to the app root so taps land on
// the open chat list. A push with no showable content is dropped silently;
// an empty notification is worse than none.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    try {
      data = { body: event.data.text() };
    } catch {}
  }
  const title = data.title || "Klanker";
  const body = typeof data.body === "string" ? data.body : "";
  if (!body && !data.title) return;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.tag || "klanker",
      icon: "/klanker.svg",
      data: { url: typeof data.url === "string" ? data.url : "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const open = clients.find((c) => "focus" in c);
        if (open) {
          if (target !== "/" && "navigate" in open) void open.navigate(target);
          return open.focus();
        }
        return self.clients.openWindow(target);
      })
  );
});
