import type { Style } from './types'

/**
 * Font presets. Each maps to one of the typefaces Excalidraw ships (self-hosted under
 * public/fonts), by its Excalidraw font-family number and its registered CSS family name.
 */
export const FONT_PRESETS = [
  { id: 'hand', label: 'Hand-drawn', family: 5, css: 'Excalifont', charWidth: 0.55, note: 'the default sketchy handwriting' },
  { id: 'virgil', label: 'Classic sketch', family: 1, css: 'Virgil', charWidth: 0.58, note: 'the original Excalidraw handwriting' },
  { id: 'normal', label: 'Rounded', family: 6, css: 'Nunito', charWidth: 0.52, note: 'a friendly rounded sans' },
  { id: 'sans', label: 'Plain', family: 9, css: 'Liberation Sans', charWidth: 0.52, note: 'a neutral sans, like Arial' },
  { id: 'display', label: 'Headline', family: 7, css: 'Lilita One', charWidth: 0.5, note: 'a bold display face for titles' },
  { id: 'code', label: 'Code', family: 8, css: 'Comic Shanns', charWidth: 0.6, note: 'an informal monospace' },
  { id: 'mono', label: 'Monospace', family: 3, css: 'Cascadia', charWidth: 0.6, note: 'a crisp monospace for code' },
] as const

export type FontId = (typeof FONT_PRESETS)[number]['id']

export const FONT_IDS = FONT_PRESETS.map((f) => f.id) as [FontId, ...FontId[]]

export const DEFAULT_FONT: FontId = 'hand'

const byId = new Map(FONT_PRESETS.map((f) => [f.id as FontId, f]))
const byFamily = new Map(FONT_PRESETS.map((f) => [f.family as number, f.id as FontId]))

export function fontPreset(id: FontId | undefined) {
  return byId.get(id ?? DEFAULT_FONT)!
}

/** The preset for an Excalidraw font-family number, if it is one of ours. */
export function fontForFamily(family: number | undefined): FontId | undefined {
  return family === undefined ? undefined : byFamily.get(family)
}

/** Board defaults with `font` as the board font. The default font is implied, so it is left out. */
export function withBoardFont(defaults: Style, font: FontId): Style {
  const next: Style = { ...defaults, font }
  if (font === DEFAULT_FONT) delete next.font
  return next
}
