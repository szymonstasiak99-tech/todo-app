importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyC2A2CWELZhKxzWOgDhLo00MXL5XXc57Lg",
  authDomain: "to-do-list-6a109.firebaseapp.com",
  projectId: "to-do-list-6a109",
  storageBucket: "to-do-list-6a109.firebasestorage.app",
  messagingSenderId: "562220006928",
  appId: "1:562220006928:web:7c63d991fe0e3d22111495"
});

// Background pushes (app/tab closed) land here. Foreground pushes (app open)
// are handled client-side instead, see onMessage() in index.html.
const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "DoDaily";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, {
    body,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { link: (payload.fcmOptions && payload.fcmOptions.link) || (payload.data && payload.data.link) || "./index.html" }
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "./index.html";
  event.waitUntil(clients.openWindow(link));
});

const CACHE_NAME = "dodaily-shell-v2";
const APP_SHELL = [
  "./index.html",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// The app is nothing without a live Firestore connection, so this worker
// only exists to satisfy PWA installability and give a minimal offline
// fallback — it never serves stale app code while the network is up.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for everything, not just navigation: icons and manifest.json
  // change on their own release cadence, separate from CACHE_NAME - a
  // cache-first strategy here silently pins whatever version happened to be
  // live the first time each file was fetched, until CACHE_NAME is bumped
  // again. Only the offline fallback reaches into the cache.
  event.respondWith(
    fetch(req).then((res) => {
      const resClone = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
      return res;
    }).catch(() => caches.match(req).then((cached) => cached || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
