import { describe, expect, it } from 'vitest'
import { settingsSchema } from './schema'

describe('settingsSchema', () => {
  it('fills every default from an empty object', () => {
    const s = settingsSchema.parse({})
    expect(s.voice.mode).toBe('on-device')
    expect(s.voice.onDeviceModel).toBe('moonshine-base')
    expect(s.providers['azure-foundry']).toMatchObject({ endpointStyle: 'auto', apiVersion: '' })
    expect(s.shortcuts).toEqual({ focusPrompt: '/', pushToTalk: 'Ctrl+Shift+Space' })
  })

  it('has no field that can carry an API key', () => {
    const s = settingsSchema.parse({ providers: { 'azure-foundry': { apiKey: 'leak' } } })
    expect(JSON.stringify(s)).not.toContain('leak')
  })
})
