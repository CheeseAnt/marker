import type { SpeechDevice } from './models'
import type { WorkerRequest, WorkerResponse } from './worker'

/** transformers.js keeps downloaded models in this Cache Storage bucket. */
const MODEL_CACHE = 'transformers-cache'

export interface LoadProgress {
  loaded: number
  total: number
}

/** The speech worker, created on first use and kept for the session. */
class OnDeviceRecognizer {
  private worker: Worker | null = null
  private repo = ''
  private ready: Promise<SpeechDevice> | null = null
  private pending = new Map<number, { resolve: (r: { text: string; ms: number }) => void; reject: (e: Error) => void }>()
  private nextId = 1
  private progressListener: ((p: LoadProgress) => void) | null = null

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data
      if (msg.type === 'progress') this.progressListener?.({ loaded: msg.loaded, total: msg.total })
      if (msg.type === 'result') {
        this.pending.get(msg.id)?.resolve({ text: msg.text, ms: msg.ms })
        this.pending.delete(msg.id)
      }
      if (msg.type === 'error' && msg.id !== undefined) {
        this.pending.get(msg.id)?.reject(new Error(msg.message))
        this.pending.delete(msg.id)
      }
    }
    this.worker = worker
    return worker
  }

  /** Downloads (once) and loads the model; resolves with the device it runs on. */
  load(repo: string, onProgress?: (p: LoadProgress) => void): Promise<SpeechDevice> {
    this.progressListener = onProgress ?? null
    if (this.ready && this.repo === repo) return this.ready
    const worker = this.ensureWorker()
    this.repo = repo
    this.ready = new Promise<SpeechDevice>((resolve, reject) => {
      const listen = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data
        if (msg.type === 'ready') {
          worker.removeEventListener('message', listen)
          resolve(msg.device)
        } else if (msg.type === 'error' && msg.id === undefined) {
          worker.removeEventListener('message', listen)
          this.ready = null
          reject(new Error(`Couldn't load the speech model: ${msg.message}`))
        }
      }
      worker.addEventListener('message', listen)
    })
    worker.postMessage({ type: 'load', repo } satisfies WorkerRequest)
    return this.ready
  }

  async transcribe(repo: string, audio: Float32Array): Promise<{ text: string; ms: number }> {
    await this.load(repo, this.progressListener ?? undefined)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ type: 'transcribe', id, audio } satisfies WorkerRequest, [audio.buffer])
    })
  }
}

export const onDevice = new OnDeviceRecognizer()

async function modelKeys(repo: string): Promise<{ cache: Cache; keys: readonly Request[] } | undefined> {
  if (typeof caches === 'undefined') return undefined
  const cache = await caches.open(MODEL_CACHE)
  const keys = (await cache.keys()).filter((r) => r.url.includes(`/${repo}/resolve/`))
  return { cache, keys }
}

/** Whether the model's weights are already in this browser. */
export async function isModelDownloaded(repo: string): Promise<boolean> {
  const found = await modelKeys(repo)
  return Boolean(found?.keys.some((r) => r.url.includes('/onnx/')))
}

export async function deleteModel(repo: string): Promise<void> {
  const found = await modelKeys(repo)
  if (found) await Promise.all(found.keys.map((r) => found.cache.delete(r)))
}
