import { useToast } from './state/toast'

const RELOADED_FOR_ISOLATION = 'boardbot.reloadedForIsolation'

/**
 * Registers the offline service worker (production builds only). On a host that doesn't send the
 * isolation headers, the page reloads once so the worker can add them; a new version is offered
 * as a reload rather than swapped in under the user.
 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    if (!crossOriginIsolated && navigator.serviceWorker.controller && !sessionStorage.getItem(RELOADED_FOR_ISOLATION)) {
      sessionStorage.setItem(RELOADED_FOR_ISOLATION, '1')
      location.reload()
      return
    }
    const offerUpdate = (worker: ServiceWorker) =>
      useToast.getState().show({
        kind: 'reply',
        text: 'A new version of BoardBot is ready.',
        action: {
          label: 'Reload',
          run: () => {
            navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true })
            worker.postMessage('SKIP_WAITING')
          },
        },
      })
    if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting)
    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing
      incoming?.addEventListener('statechange', () => {
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(incoming)
      })
    })
  } catch {
    // Without the service worker the app still works online.
  }
}
