/**
 * The subset of Excalidraw's element shape that BoardBot reads and writes. Kept structural
 * (no branded types) so compile/decompile stay pure and testable without Excalidraw loaded.
 */
export interface ExBinding {
  elementId: string
  focus: number
  gap: number
}

export interface ExElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  strokeColor: string
  backgroundColor: string
  fillStyle: string
  strokeWidth: number
  strokeStyle: string
  roughness: number
  opacity: number
  roundness: { type: number; value?: number } | null
  seed: number
  version: number
  versionNonce: number
  index: string | null
  isDeleted: boolean
  groupIds: readonly string[]
  frameId: string | null
  boundElements: readonly { id: string; type: 'arrow' | 'text' }[] | null
  updated: number
  link: string | null
  locked: boolean
  // text
  text?: string
  originalText?: string
  fontSize?: number
  fontFamily?: number
  textAlign?: string
  verticalAlign?: string
  containerId?: string | null
  autoResize?: boolean
  lineHeight?: number
  // arrow, line, freedraw
  points?: readonly (readonly [number, number])[]
  lastCommittedPoint?: null
  startBinding?: ExBinding | null
  endBinding?: ExBinding | null
  startArrowhead?: string | null
  endArrowhead?: string | null
  elbowed?: boolean
  pressures?: readonly number[]
  simulatePressure?: boolean
  // image
  fileId?: string | null
  status?: string
  scale?: [number, number]
  crop?: null
}

export const LABEL_SUFFIX = '~label'

export function labelId(ownerId: string): string {
  return ownerId + LABEL_SUFFIX
}

export const FONT_FAMILY = { hand: 5, normal: 6, code: 8 } as const
export const ROUNDNESS = { proportional: 2, adaptive: 3 } as const
export const DEFAULT_STROKE = '#1e1e1e'
export const DEFAULT_FILL = 'transparent'
export const STICKY_FILL = '#fff3bf'
export const BIND_GAP = 6

export const FILL_STYLE = { hachure: 'hachure', solid: 'solid', cross: 'cross-hatch', zigzag: 'zigzag' } as const
