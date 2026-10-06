// The phone page's service worker, served as /sw.js by remote.rs: it shows
// the task notices Loom pushes (push.ts builds them) and, on a tap, opens the
// agent in Loom's page, the one already open if there is one.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let m = {};
  try {
    m = e.data ? e.data.json() : {};
  } catch {
    // Not Loom's JSON: it still shows, as Chrome requires of every push.
  }
  e.waitUntil(self.registration.showNotification(m.title || "Loom", {
    body: m.body || "",
    // One per agent: a newer one replaces it, and buzzes again.
    tag: m.tag || "loom",
    renotify: true,
    icon: "/icon.png",
    timestamp: m.at || Date.now(),
    data: { url: m.url || "/", pane: m.tag || "", at: m.at || Date.now() },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin);
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const page = open.find((c) => new URL(c.url).origin === url.origin);
    if (!page) return self.clients.openWindow(url.href);
    // The page goes there itself (remote.ts), without reloading.
    page.postMessage({ open: url.hash });
    return page.focus();
  })());
});
