/** A key combination written like "Ctrl+Shift+Space" or "/". */
export interface Shortcut {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** KeyboardEvent.code for named keys ("Space", "KeyM"), or the character for single keys ("/"). */
  key: string
}

const NAMED: Record<string, string> = { space: 'Space', enter: 'Enter', tab: 'Tab', backquote: 'Backquote' }

export function parseShortcut(text: string): Shortcut | undefined {
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return undefined
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase())
  if (mods.some((m) => !['ctrl', 'shift', 'alt', 'option', 'cmd', 'meta'].includes(m))) return undefined
  const last = parts.at(-1)!
  const key = NAMED[last.toLowerCase()] ?? (/^[a-z]$/i.test(last) ? `Key${last.toUpperCase()}` : /^\d$/.test(last) ? `Digit${last}` : last)
  return {
    ctrl: mods.includes('ctrl'),
    shift: mods.includes('shift'),
    alt: mods.includes('alt') || mods.includes('option'),
    meta: mods.includes('cmd') || mods.includes('meta'),
    key,
  }
}

export function matchesShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code' | 'key'>, s: Shortcut): boolean {
  if (e.ctrlKey !== s.ctrl || e.altKey !== s.alt || e.metaKey !== s.meta) return false
  // Single characters like "/" are matched by character, since their key code depends on the layout.
  if (s.key.length === 1) return e.key === s.key
  return e.shiftKey === s.shift && e.code === s.key
}

/** The shortcut a key press would set, for recording one in Settings; undefined for bare modifiers. */
export function shortcutFromEvent(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code' | 'key'>): string | undefined {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return undefined
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.metaKey && 'Cmd', e.shiftKey && 'Shift'].filter(Boolean) as string[]
  const named = Object.entries(NAMED).find(([, code]) => code === e.code)?.[0]
  const key = named ? named[0].toUpperCase() + named.slice(1) : e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key
  // A printable key on its own (like "/") keeps its character and ignores Shift.
  if (!mods.filter((m) => m !== 'Shift').length && key.length === 1 && !e.code.startsWith('Key') && !e.code.startsWith('Digit')) return e.key
  return [...mods, key].join('+')
}

/** Shortcuts Excalidraw or the browser already use, with what they do, for conflict warnings. */
export const RESERVED_SHORTCUTS: Record<string, string> = {
  Space: 'panning the canvas',
  '?': 'Excalidraw help',
  'Ctrl+Z': 'undo',
  'Ctrl+Shift+Z': 'redo',
  'Ctrl+Y': 'redo',
  'Cmd+Z': 'undo',
  'Cmd+Shift+Z': 'redo',
  'Ctrl+/': 'the command palette',
  'Cmd+/': 'the command palette',
  'Ctrl+Space': 'switching input languages (Windows, macOS)',
  'Cmd+Space': 'Spotlight (macOS)',
  'Cmd+Shift+M': 'the Chrome profile menu',
  ...Object.fromEntries('123456789'.split('').map((d) => [d, 'an Excalidraw tool'])),
  ...Object.fromEntries('RDOALTPEIHXK'.split('').map((k) => [k, 'an Excalidraw tool'])),
}

export function shortcutConflict(text: string): string | undefined {
  const normalized = text.replace(/\bOption\b/, 'Alt').replace(/\bMeta\b/, 'Cmd')
  return RESERVED_SHORTCUTS[normalized] ?? RESERVED_SHORTCUTS[normalized.toUpperCase()]
}
