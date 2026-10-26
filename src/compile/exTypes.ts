/**
 * The subset of Excalidraw's element shape that Marker reads and writes. Kept structural
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
  crop?: ExCrop | null
}

export interface ExCrop {
  x: number
  y: number
  width: number
  height: number
  naturalWidth: number
  naturalHeight: number
}

/** Image crop as a render hint: "x,y,width,height,naturalWidth,naturalHeight". */
export function cropToHint(crop: ExCrop | null | undefined): string | null {
  if (!crop) return null
  return [crop.x, crop.y, crop.width, crop.height, crop.naturalWidth, crop.naturalHeight].map((n) => Math.round(n * 100) / 100).join(',')
}

export function cropFromHint(hint: unknown): ExCrop | null {
  if (typeof hint !== 'string') return null
  const [x, y, width, height, naturalWidth, naturalHeight] = hint.split(',').map(Number)
  return [x, y, width, height, naturalWidth, naturalHeight].some((n) => !Number.isFinite(n)) ? null : { x, y, width, height, naturalWidth, naturalHeight }
}

/** Image flip as a render hint: "h", "v" or "hv". */
export function flipToHint(scale: readonly [number, number] | undefined): string | null {
  if (!scale) return null
  const flip = `${scale[0] < 0 ? 'h' : ''}${scale[1] < 0 ? 'v' : ''}`
  return flip || null
}

export const LABEL_SUFFIX = '~label'

export function labelId(ownerId: string): string {
  return ownerId + LABEL_SUFFIX
}

export const ROUNDNESS = { proportional: 2, adaptive: 3 } as const
export const DEFAULT_STROKE = '#1e1e1e'
export const DEFAULT_FILL = 'transparent'
export const STICKY_FILL = '#fff3bf'
export const BIND_GAP = 6

export const FILL_STYLE = { hachure: 'hachure', solid: 'solid', cross: 'cross-hatch', zigzag: 'zigzag' } as const
