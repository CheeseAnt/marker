// Kept a real file: the content security policy refuses inlined (data:) scripts.
import workletUrl from './recorder.worklet.js?url&no-inline'

/** Speech models expect 16 kHz mono. */
export const SPEECH_SAMPLE_RATE = 16_000
/** Longer recordings are cut off; requests are short. */
export const MAX_RECORDING_SECONDS = 60

export interface Recording {
  /** Stops and returns 16 kHz mono samples. */
  stop(): Promise<Float32Array>
  cancel(): void
  /** Recent loudness, 0 to 1, for a level meter. */
  level(): number
}

export class MicrophoneError extends Error {}

async function openMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicrophoneError('This browser can\'t record audio here. Voice input needs HTTPS.')
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  } catch (e) {
    const name = (e as DOMException).name
    if (name === 'NotAllowedError') throw new MicrophoneError('Microphone access is blocked. Allow it in the browser\'s site settings to use voice.')
    if (name === 'NotFoundError') throw new MicrophoneError('No microphone was found.')
    throw new MicrophoneError(`Couldn't open the microphone: ${(e as Error).message}`)
  }
}

/** Resamples to 16 kHz with the browser's own resampler. */
export async function resample(samples: Float32Array, fromRate: number): Promise<Float32Array> {
  if (fromRate === SPEECH_SAMPLE_RATE || samples.length === 0) return samples
  const frames = Math.max(1, Math.round((samples.length * SPEECH_SAMPLE_RATE) / fromRate))
  const offline = new OfflineAudioContext(1, frames, SPEECH_SAMPLE_RATE)
  const buffer = offline.createBuffer(1, samples.length, fromRate)
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
  const source = offline.createBufferSource()
  source.buffer = buffer
  source.connect(offline.destination)
  source.start()
  return (await offline.startRendering()).getChannelData(0)
}

export async function startRecording(): Promise<Recording> {
  const stream = await openMicrophone()
  const context = new AudioContext()
  await context.audioWorklet.addModule(workletUrl)
  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'marker-recorder')
  const chunks: Float32Array[] = []
  let length = 0
  let level = 0
  const limit = MAX_RECORDING_SECONDS * context.sampleRate
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (length >= limit) return
    chunks.push(event.data)
    length += event.data.length
    let sum = 0
    for (const s of event.data) sum += s * s
    // Smoothed RMS, scaled so ordinary speech reaches the top of the meter.
    level = level * 0.8 + Math.min(1, Math.sqrt(sum / event.data.length) * 6) * 0.2
  }
  source.connect(node)

  const close = () => {
    source.disconnect()
    node.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void context.close()
  }

  return {
    stop: async () => {
      close()
      const samples = new Float32Array(length)
      let offset = 0
      for (const c of chunks) {
        samples.set(c, offset)
        offset += c.length
      }
      return resample(samples, context.sampleRate)
    },
    cancel: close,
    level: () => level,
  }
}
