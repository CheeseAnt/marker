/// <reference lib="webworker" />
// Runs speech recognition off the main thread so the canvas stays responsive.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { dtypeFor, type SpeechDevice } from './models'

env.allowLocalModels = false
// The ONNX runtime is served by this app (see scripts/copy-static-assets.mjs), not a CDN.
env.backends.onnx.wasm!.wasmPaths = {
  mjs: '/ort/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm',
}

export type WorkerRequest =
  | { type: 'load'; repo: string }
  | { type: 'transcribe'; id: number; audio: Float32Array }

export type WorkerResponse =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; device: SpeechDevice; ms: number }
  | { type: 'result'; id: number; text: string; ms: number }
  | { type: 'error'; id?: number; message: string }

let recognizer: Promise<AutomaticSpeechRecognitionPipeline> | null = null
let loadedRepo = ''

const post = (message: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(message)

async function pickDevice(): Promise<SpeechDevice> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    if (gpu && (await gpu.requestAdapter())) return 'webgpu'
  } catch {
    // Fall through to WASM.
  }
  return 'wasm'
}

function load(repo: string) {
  if (recognizer && loadedRepo === repo) return recognizer
  loadedRepo = repo
  const files = new Map<string, { loaded: number; total: number }>()
  const started = performance.now()
  recognizer = (async () => {
    const device = await pickDevice()
    const asr = (await pipeline('automatic-speech-recognition', repo, {
      device,
      dtype: dtypeFor(device) as never,
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file) return
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 })
        let loaded = 0
        let total = 0
        for (const f of files.values()) {
          loaded += f.loaded
          total += f.total
        }
        post({ type: 'progress', loaded, total })
      },
    })) as AutomaticSpeechRecognitionPipeline
    post({ type: 'ready', device, ms: Math.round(performance.now() - started) })
    return asr
  })()
  recognizer.catch((e: Error) => {
    recognizer = null
    post({ type: 'error', message: e.message })
  })
  return recognizer
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type === 'load') {
    void load(msg.repo)
    return
  }
  try {
    if (!recognizer) throw new Error('The speech model is not loaded.')
    const asr = await recognizer
    const started = performance.now()
    const output = (await asr(msg.audio)) as { text: string } | { text: string }[]
    const text = (Array.isArray(output) ? output.map((o) => o.text).join(' ') : output.text).trim()
    post({ type: 'result', id: msg.id, text, ms: Math.round(performance.now() - started) })
  } catch (e) {
    post({ type: 'error', id: msg.id, message: (e as Error).message })
  }
}
