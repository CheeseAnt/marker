import { get, set } from 'idb-keyval'

/** An image kept for the board or a request. `id` is the SHA-1 of its bytes, like Excalidraw's file ids. */
export interface Asset {
  id: string
  mimeType: string
  dataURL: string
  width: number
  height: number
  created: number
}

const key = (id: string) => `marker.asset.${id}`
const cache = new Map<string, Asset>()

export async function loadAsset(id: string): Promise<Asset | undefined> {
  const cached = cache.get(id)
  if (cached) return cached
  try {
    const stored = await get<Asset>(key(id))
    if (stored) cache.set(id, stored)
    return stored
  } catch {
    return undefined
  }
}

export async function saveAsset(asset: Asset): Promise<void> {
  if (cache.get(asset.id)?.dataURL === asset.dataURL) return
  cache.set(asset.id, asset)
  await set(key(asset.id), asset)
}

/** Already in memory (loaded or saved this session), without touching storage. */
export function cachedAsset(id: string): Asset | undefined {
  return cache.get(id)
}
