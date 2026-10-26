import type { Box } from '../model/geometry'

/** Excalidraw's scroll and zoom: what's needed to put a scene point on the screen. */
export interface View {
  scrollX: number
  scrollY: number
  zoom: number
}

export function toScreen(b: Box, v: View): Box {
  return { x: (b.x + v.scrollX) * v.zoom, y: (b.y + v.scrollY) * v.zoom, w: b.w * v.zoom, h: b.h * v.zoom }
}
