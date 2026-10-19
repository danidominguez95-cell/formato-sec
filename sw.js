// Service worker: permite instalar la app, abrirla sin conexión y recibir audios compartidos (Android).
const VERSION = "sec-v7";
const ARCHIVOS = ["./", "index.html", "styles.css", "app.js", "reglas.js", "mp4audio.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== VERSION && k !== "compartido").map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (e.request.method === "POST" && url.pathname.endsWith("/compartir")) {
    e.respondWith((async () => {
      const datos = await e.request.formData();
      const archivo = datos.get("audio");
      if (archivo) {
        const cache = await caches.open("compartido");
        await cache.put("audio-compartido", new Response(archivo, {
          headers: { "Content-Type": archivo.type || "audio/ogg", "X-Nombre": encodeURIComponent(archivo.name || "audio") },
        }));
      }
      return Response.redirect("./?compartido=1", 303);
    })());
    return;
  }

  if (e.request.method !== "GET") return;
  // Red primero para recibir siempre la última versión; caché si no hay conexión.
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copia = resp.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copia));
        return resp;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
