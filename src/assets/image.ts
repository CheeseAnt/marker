import type { Asset } from './store'

/** Long side for images sent to the model; larger ones cost more and gain little. */
export const MODEL_MAX_SIDE = 1568

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha1(blob: Blob): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-1', await blob.arrayBuffer()))
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function dataURLToBlob(dataURL: string): Promise<Blob> {
  return (await fetch(dataURL)).blob()
}

/**
 * Reads an image file into an asset, scaling it down so its long side is at most `maxSide`.
 * Photos become JPEG; anything else stays PNG so transparency survives.
 */
export async function imageToAsset(file: Blob, maxSide = MODEL_MAX_SIDE): Promise<Asset> {
  if (!file.type.startsWith('image/')) throw new Error('That file isn\'t an image.')
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  let blob: Blob = file
  if (scale < 1 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    blob = await canvas.convertToBlob({ type, quality: 0.86 })
  }
  bitmap.close()
  return { id: await sha1(blob), mimeType: blob.type, dataURL: await blobToDataURL(blob), width, height, created: Date.now() }
}

/** Natural size of an image given as a data URL. */
export async function imageSize(dataURL: string): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(await dataURLToBlob(dataURL))
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return size
}

export function isImageAsset(asset: Pick<Asset, 'mimeType'>): boolean {
  return asset.mimeType.startsWith('image/')
}
