/** On-device speech models (English). Sizes are the downloads for each runtime, in MB. */
export const SPEECH_MODELS = [
  {
    id: 'moonshine-base',
    label: 'Moonshine base',
    repo: 'onnx-community/moonshine-base-ONNX',
    note: 'Fast and accurate for short English commands.',
    size: { wasm: 63, webgpu: 154 },
  },
  {
    id: 'moonshine-tiny',
    label: 'Moonshine tiny',
    repo: 'onnx-community/moonshine-tiny-ONNX',
    note: 'Smallest and quickest; for slower computers.',
    size: { wasm: 28, webgpu: 76 },
  },
  {
    id: 'whisper-base.en',
    label: 'Whisper base',
    repo: 'onnx-community/whisper-base.en',
    note: 'Well-proven, a little slower than Moonshine base.',
    size: { wasm: 77, webgpu: 206 },
  },
  {
    id: 'whisper-small.en',
    label: 'Whisper small',
    repo: 'onnx-community/whisper-small.en',
    note: 'The most accurate; needs a fast GPU to keep up.',
    size: { wasm: 249, webgpu: 586 },
  },
] as const

export type SpeechModelId = (typeof SPEECH_MODELS)[number]['id']
export type SpeechDevice = 'webgpu' | 'wasm'

export function speechModel(id: SpeechModelId) {
  return SPEECH_MODELS.find((m) => m.id === id)!
}

/** WebGPU runs a full-precision encoder with a 4-bit decoder; WASM uses 8-bit weights throughout. */
export function dtypeFor(device: SpeechDevice) {
  return device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8'
}
