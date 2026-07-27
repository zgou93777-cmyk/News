"use strict";

const CACHE_VERSION = "policy-monitor-v14";
const SCOPE_URL = new URL(self.registration.scope);
const SHELL_URLS = [
  new URL("./", SCOPE_URL).toString(),
  new URL("index.html", SCOPE_URL).toString(),
  new URL("styles.css?v=20260727-judgment3", SCOPE_URL).toString(),
  new URL("app.js?v=20260727-judgment3", SCOPE_URL).toString(),
  new URL("manifest.webmanifest?v=20260720", SCOPE_URL).toString(),
  new URL("assets/lucide-0.468.0.min.js", SCOPE_URL).toString(),
  new URL("assets/icon.svg", SCOPE_URL).toString(),
  new URL("assets/icon-180.png", SCOPE_URL).toString(),
  new URL("assets/icon-192.png", SCOPE_URL).toString(),
  new URL("assets/icon-512.png", SCOPE_URL).toString()
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_VERSION);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || (fallbackUrl ? cache.match(fallbackUrl) : Response.error());
  } finally {
    clearTimeout(timeout);
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) return;

  if (url.pathname.startsWith(`${SCOPE_URL.pathname}admin/`)
    || url.pathname.startsWith(`${SCOPE_URL.pathname}api/admin/`)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, new URL("index.html", SCOPE_URL).toString()));
    return;
  }

  if (url.pathname.startsWith(`${SCOPE_URL.pathname}api/`)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() || "有一条新的政策动态" };
  }

  const title = payload.title || "政知镜 · 新政策提醒";
  const targetUrl = new URL(payload.url || "./#/", SCOPE_URL).toString();
  const options = {
    body: payload.body || payload.summary || "新的政策分析已经发布，点击查看。",
    icon: new URL("assets/icon.svg", SCOPE_URL).toString(),
    badge: new URL("assets/icon.svg", SCOPE_URL).toString(),
    tag: payload.tag || `policy-${payload.articleId || payload.article_id || Date.now()}`,
    renotify: Boolean(payload.renotify),
    data: { url: targetUrl, ...(payload.data || {}) }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || new URL("./#/", SCOPE_URL).toString();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === SCOPE_URL.origin) {
          await client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const keyResponse = await fetch(new URL("api/push/public-key", SCOPE_URL));
    if (!keyResponse.ok) return;
    const keyPayload = await keyResponse.json();
    const publicKey = keyPayload.publicKey || keyPayload.public_key || keyPayload.vapidPublicKey || keyPayload.data?.publicKey;
    if (!publicKey) return;

    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await fetch(new URL("api/push/subscribe", SCOPE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON(), platform: "service-worker-refresh" })
    });
  })());
});
