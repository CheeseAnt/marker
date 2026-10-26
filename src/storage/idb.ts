import { del, get, set } from 'idb-keyval'

const BOARD_KEY = 'boardbot.board.v1'
// Phase 1 autosaved the raw Excalidraw scene; it is migrated once and then deleted.
const LEGACY_SCENE_KEY = 'boardbot.scene.v0'
const CORRUPT_KEY = 'boardbot.board.corrupt'

export async function loadBoardText(): Promise<string | undefined> {
  try {
    return await get<string>(BOARD_KEY)
  } catch {
    return undefined
  }
}

export async function saveBoardText(text: string): Promise<void> {
  await set(BOARD_KEY, text)
}

/** Keeps unreadable board text aside instead of overwriting it. */
export async function quarantineBoardText(text: string): Promise<void> {
  await set(CORRUPT_KEY, { text, at: Date.now() })
}

export async function loadLegacyScene(): Promise<readonly unknown[] | undefined> {
  try {
    return (await get<{ elements: readonly unknown[] }>(LEGACY_SCENE_KEY))?.elements
  } catch {
    return undefined
  }
}

export async function deleteLegacyScene(): Promise<void> {
  await del(LEGACY_SCENE_KEY)
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
