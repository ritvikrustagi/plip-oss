/**
 * Registers the service worker, so the app installs on a Chromebook and opens
 * without the network. Silent when the browser has no service workers (or a
 * school policy has switched them off): the app is a plain page then, which
 * still works as long as there is a connection.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  // file:// has no service worker scope, and neither does a test harness
  // pointed at the built folder. Don't warn about it.
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('./sw.js', document.baseURI).href, { scope: './' })
      .catch(() => {
        // Offline support is the only thing lost, and it is a bonus here.
      })
  })
}
