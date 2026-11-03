"use strict";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try {data = event.data?.json() || {};} catch { /* Still show a visible alert. */ }
    await self.registration.showNotification(data.title || "Paradeis", {
      body: data.body || "Your timer has changed.", tag: data.tag || "paradeis-companion",
      icon: "/static/app-icon-192.png", badge: "/static/icon.svg",
    });
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    for (const client of windows) client.postMessage({type: "timer-push"});
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow("/");
    })(),
  );
});
