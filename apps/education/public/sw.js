/**
 * The service worker: just enough to make the app installable and to open
 * offline on a Chromebook that has lost its wifi.
 *
 * It caches the app shell (HTML, JS, CSS, icons) and nothing else. Every /api
 * request goes to the network and is never cached or stored: a student's work
 * does not belong in a cache that outlives the session. Nothing is uploaded
 * from here - the page itself holds the offline queue and only drains it when
 * the student is in a running session.
 */
const SHELL = 'plip-education-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL)
    await cache.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png'].map((path) => new Request(path, { cache: 'reload' })))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== SHELL) await caches.delete(name)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  // Student work: network only, never cached, never queued here.
  if (url.pathname.startsWith('/api/') || request.method !== 'GET') return
  if (url.origin !== self.location.origin) return

  event.respondWith((async () => {
    const cache = await caches.open(SHELL)
    const cached = await cache.match(request, { ignoreSearch: true })
    if (cached) {
      // Refresh the shell in the background so the next launch is current.
      event.waitUntil(fetch(request).then((fresh) => fresh.ok && cache.put(request, fresh.clone())).catch(() => {}))
      return cached
    }
    try {
      const fresh = await fetch(request)
      if (fresh.ok && request.destination !== '') await cache.put(request, fresh.clone())
      return fresh
    } catch {
      const shell = await cache.match('./index.html')
      if (shell && request.mode === 'navigate') return shell
      throw new Error('offline and not in the shell cache')
    }
  })())
})
