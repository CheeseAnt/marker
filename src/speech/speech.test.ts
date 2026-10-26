import { describe, expect, it, vi } from 'vitest'
import { createAzureFoundryProvider } from '../ai/providers/azureFoundry'
import { settingsSchema } from '../settings/schema'
import { createVoiceEngine } from './engines'
import { matchesShortcut, parseShortcut, shortcutConflict, shortcutFromEvent } from './shortcut'
import { encodeWav } from './wav'

const key = (code: string, k: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
  code,
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

describe('shortcuts', () => {
  it('parses and matches modifier combinations by key code', () => {
    const talk = parseShortcut('Ctrl+Shift+Space')!
    expect(talk).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'Space' })
    expect(matchesShortcut(key('Space', ' ', { ctrlKey: true, shiftKey: true }), talk)).toBe(true)
    expect(matchesShortcut(key('Space', ' ', { ctrlKey: true }), talk)).toBe(false)
    expect(matchesShortcut(key('KeyM', 'M', { ctrlKey: true, shiftKey: true }), parseShortcut('Ctrl+Shift+M')!)).toBe(true)
  })

  it('matches single characters by the character typed, whatever the layout', () => {
    const slash = parseShortcut('/')!
    expect(matchesShortcut(key('Slash', '/'), slash)).toBe(true)
    expect(matchesShortcut(key('Digit7', '/', { shiftKey: true }), slash)).toBe(true)
    expect(matchesShortcut(key('Slash', '/', { ctrlKey: true }), slash)).toBe(false)
  })

  it('records a shortcut from a key press', () => {
    expect(shortcutFromEvent(key('Space', ' ', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Space')
    expect(shortcutFromEvent(key('KeyK', 'k', { altKey: true }))).toBe('Alt+K')
    expect(shortcutFromEvent(key('Slash', '/'))).toBe('/')
    expect(shortcutFromEvent(key('ShiftLeft', 'Shift', { shiftKey: true }))).toBeUndefined()
  })

  it('warns about keys Excalidraw or the system already use', () => {
    expect(shortcutConflict('Ctrl+Space')).toMatch(/input languages/)
    expect(shortcutConflict('r')).toMatch(/Excalidraw tool/)
    expect(shortcutConflict('Ctrl+Shift+Space')).toBeUndefined()
    expect(shortcutConflict('/')).toBeUndefined()
  })
})

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header and clamps samples', async () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -1, 2]), 16000)
    const view = new DataView(await wav.arrayBuffer())
    const text = (o: number, n: number) => String.fromCharCode(...new Uint8Array(view.buffer, o, n))
    expect([text(0, 4), text(8, 4), text(36, 4)]).toEqual(['RIFF', 'WAVE', 'data'])
    expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([1, 16000, 16])
    expect([1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([16383, -32767, 32767])
    expect(wav.size).toBe(44 + 8)
  })
})

describe('Azure transcription', () => {
  const config = { endpoint: 'https://res.openai.azure.com', deployment: 'gpt-5.6-luna', endpointStyle: 'auto' as const, apiVersion: '', apiKey: 'k' }

  it('is only offered with a transcription deployment', () => {
    expect(createAzureFoundryProvider(config).transcribe).toBeUndefined()
    expect(createAzureFoundryProvider({ ...config, transcriptionDeployment: 'gpt-4o-transcribe' }).capabilities.transcription).toBe(true)
  })

  it('posts the audio as a form and reports tokens and duration', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: ' add a cache ', usage: { input_tokens: 40, output_tokens: 5 } })))
    const provider = createAzureFoundryProvider({ ...config, transcriptionDeployment: 'gpt-4o-transcribe' }, fetchMock as unknown as typeof fetch)
    const audio = encodeWav(new Float32Array(16000 * 2), 16000)
    const result = await provider.transcribe!(audio)
    expect(result).toEqual({ text: 'add a cache', audioSeconds: 2, usage: { inputTokens: 40, outputTokens: 5 } })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://res.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview')
    const form = init.body as FormData
    expect((form.get('file') as File).name).toBe('speech.wav')
    expect(form.get('language')).toBe('en')
    expect(init.headers).toEqual({ 'api-key': 'k' })
  })
})

describe('voice engines', () => {
  const base = settingsSchema.parse({})
  const noUsage = () => {}

  it('explains why voice is unavailable', () => {
    expect(createVoiceEngine({ ...base, voice: { ...base.voice, mode: 'off' } }, {}, noUsage)).toEqual({ unavailable: expect.stringMatching(/off/) })
    expect(createVoiceEngine({ ...base, voice: { ...base.voice, mode: 'remote' } }, {}, noUsage)).toEqual({
      unavailable: expect.stringMatching(/transcription deployment/),
    })
  })

  it('uses the chosen on-device model', () => {
    const choice = createVoiceEngine({ ...base, voice: { ...base.voice, onDeviceModel: 'whisper-base.en' } }, {}, noUsage)
    expect('engine' in choice && choice.engine.label).toBe('Whisper base')
  })
})
