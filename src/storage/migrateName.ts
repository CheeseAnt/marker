import { createStore, delMany, entries, setMany } from 'idb-keyval'

// The app was called BoardBot until 2026-10-26. Data saved under the old name moves to the new
// keys once: everything is copied before anything is deleted, so an interrupted move just repeats.
const OLD_PREFIX = 'boardbot.'
const NEW_PREFIX = 'marker.'
const OLD_USAGE_DB = 'boardbot-usage'
const NEW_USAGE_DB = 'marker-usage'
const LOCAL_KEYS = ['settings', 'secrets']

/** The new name for a key saved under the old prefix, or undefined if it isn't one. */
export function renamedKey(key: IDBValidKey): string | undefined {
  return typeof key === 'string' && key.startsWith(OLD_PREFIX) ? NEW_PREFIX + key.slice(OLD_PREFIX.length) : undefined
}

/** Settings and the API key. Synchronous, so it runs before the settings store first reads them. */
export function migrateLocalStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage): void {
  try {
    for (const name of LOCAL_KEYS) {
      const old = storage.getItem(OLD_PREFIX + name)
      if (old === null) continue
      if (storage.getItem(NEW_PREFIX + name) === null) storage.setItem(NEW_PREFIX + name, old)
      storage.removeItem(OLD_PREFIX + name)
    }
  } catch {
    // Storage can be unavailable (private mode); there's nothing to move then.
  }
}

async function usageDbExists(): Promise<boolean> {
  if (!indexedDB.databases) return true
  return (await indexedDB.databases()).some((db) => db.name === OLD_USAGE_DB)
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = request.onerror = request.onblocked = () => resolve()
  })
}

/** The board, history, file handle, templates, images and usage records. */
export async function migrateIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    const moved = (await entries()).flatMap(([key, value]) => {
      const to = renamedKey(key)
      return to ? [{ from: key, to, value }] : []
    })
    if (moved.length) {
      await setMany(moved.map((m) => [m.to, m.value]))
      await delMany(moved.map((m) => m.from))
    }
    if (await usageDbExists()) {
      const records = await entries(createStore(OLD_USAGE_DB, 'records'))
      if (records.length) await setMany(records, createStore(NEW_USAGE_DB, 'records'))
      await deleteDb(OLD_USAGE_DB)
    }
  } catch {
    // A failed move leaves the old data where it was, to be tried again next time.
  }
}
