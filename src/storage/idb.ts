import { get, set } from 'idb-keyval'

// Temporary autosave of the raw Excalidraw scene. Replaced by the board DSL in phase 2.
const SCENE_KEY = 'boardbot.scene.v0'

export interface StoredScene {
  elements: readonly unknown[]
  savedAt: number
}

export async function loadScene(): Promise<StoredScene | undefined> {
  try {
    return await get<StoredScene>(SCENE_KEY)
  } catch {
    return undefined
  }
}

export async function saveScene(elements: readonly unknown[]): Promise<void> {
  await set(SCENE_KEY, { elements, savedAt: Date.now() } satisfies StoredScene)
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
