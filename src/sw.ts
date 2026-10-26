/// <reference lib="webworker" />
// The offline service worker. It precaches the app shell, keeps the large files (fonts, the
// speech runtime) once they've been used, and adds the cross-origin isolation headers that
// multi-threaded speech recognition needs, so it also works on hosts that can't set headers.
import { clientsClaim } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import { addPlugins, cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] }

const ISOLATION: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

function withIsolation(response: Response): Response {
  // Opaque and redirect responses can't be rebuilt; they pass through as they are.
  if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 0) return response
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(ISOLATION)) headers.set(k, v)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

const isolate = { cachedResponseWillBeUsed: async ({ cachedResponse }: { cachedResponse?: Response }) => cachedResponse && withIsolation(cachedResponse) }

// Take over pages already open on the first install, so the very first visit works offline.
clientsClaim()
cleanupOutdatedCaches()
addPlugins([isolate])
precacheAndRoute(self.__WB_MANIFEST)

// Every page is the app; it comes from the precache, so it opens offline.
registerRoute(
  new NavigationRoute(async ({ request }) => {
    const cached = await matchPrecache('/index.html')
    return withIsolation(cached ?? (await fetch(request)))
  }),
)

// Fonts and the speech runtime are large and rarely all needed, so they're kept once fetched.
registerRoute(
  ({ url }) => url.origin === self.location.origin && (url.pathname.startsWith('/fonts/') || url.pathname.endsWith('.wasm')),
  new CacheFirst({ cacheName: 'boardbot-large', plugins: [new ExpirationPlugin({ maxEntries: 400 }), isolate] }),
)

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting()
})
