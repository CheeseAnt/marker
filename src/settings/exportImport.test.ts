import { describe, expect, it } from 'vitest'
import {
  combineSettings,
  describeChanges,
  exportSettings,
  parseSettingsFile,
  rawSettingsOf,
  SettingsFileError,
  type Migration,
} from './exportImport'
import { settingsSchema } from './schema'

const base = settingsSchema.parse({
  providers: { 'azure-foundry': { endpoint: 'https://res.openai.azure.com', deployment: 'gpt-5.6-luna' } },
  pricing: { 'gpt-5.6-luna': { input: 1.5, output: 12 } },
})
const secrets = { 'azure-foundry': { apiKey: 'super-secret-key-123' } }

describe('settings export', () => {
  it('writes a versioned file without API keys', () => {
    const text = exportSettings(base, secrets, new Date('2026-10-26T12:00:00Z'))
    const file = JSON.parse(text)
    expect(file).toMatchObject({ schema: 'marker-settings', version: 1, exportedAt: '2026-10-26T12:00:00.000Z' })
    expect(file.settings.providers['azure-foundry'].deployment).toBe('gpt-5.6-luna')
    expect(text).not.toContain('super-secret-key-123')
    expect(text).not.toMatch(/apiKey/i)
  })

  it('refuses to export if a key value would end up in the file', () => {
    const leaky = { ...base, providers: { 'azure-foundry': { ...base.providers['azure-foundry'], apiVersion: 'super-secret-key-123' } } }
    expect(() => exportSettings(leaky, secrets)).toThrow(SettingsFileError)
  })
})

describe('settings import', () => {
  const file = exportSettings(base, {})

  it('round-trips', () => {
    expect(parseSettingsFile(file)).toEqual(base)
  })

  it('reads files exported under the old name', () => {
    expect(parseSettingsFile(file.replace('"marker-settings"', '"boardbot-settings"'))).toEqual(base)
  })

  it.each([
    ['not json', /isn't valid JSON/],
    ['{"schema":"other","version":1,"settings":{}}', /isn't a Marker settings file/],
    ['{"schema":"marker-settings","version":9,"settings":{}}', /newer version of Marker \(format 9\)/],
    ['{"schema":"marker-settings","version":1,"settings":{"voice":{"mode":"shout"}}}', /invalid value at voice\.mode/],
    ['{"schema":"marker-settings","version":1,"settings":{"providers":{"azure-foundry":{"apiKey":"x"}}}}', /contains providers\.azure-foundry\.apiKey/],
    ['{"schema":"marker-settings","version":0,"settings":{}}', /from version 0 can't be read/],
  ])('rejects %s', (text, message) => {
    expect(() => parseSettingsFile(text)).toThrow(message)
  })

  it('upgrades older files through each migration in turn', () => {
    const migrations: Record<number, Migration> = { 0: (raw) => ({ ...raw, jobConcurrency: (raw.parallel as number) ?? 2 }) }
    const old = JSON.stringify({ schema: 'marker-settings', version: 0, settings: { parallel: 3 } })
    expect(parseSettingsFile(old, migrations).jobConcurrency).toBe(3)
  })

  it('replaces everything, or only what the file sets', () => {
    const partial = JSON.stringify({ schema: 'marker-settings', version: 1, settings: { voice: { mode: 'off' }, pricing: { 'gpt-4o': { input: 2 } } } })
    const incoming = parseSettingsFile(partial)
    const replaced = combineSettings(base, incoming, rawSettingsOf(partial), 'replace')
    expect(replaced.providers['azure-foundry'].endpoint).toBe('')
    expect(Object.keys(replaced.pricing)).toEqual(['gpt-4o'])
    const merged = combineSettings(base, incoming, rawSettingsOf(partial), 'merge')
    expect(merged.providers['azure-foundry'].endpoint).toBe('https://res.openai.azure.com')
    expect(merged.voice).toMatchObject({ mode: 'off', onDeviceModel: 'moonshine-base' })
    expect(Object.keys(merged.pricing).sort()).toEqual(['gpt-4o', 'gpt-5.6-luna'])
  })

  it('describes the changes in words', () => {
    const next = { ...base, voice: { ...base.voice, mode: 'remote' as const }, pricing: {} }
    expect(describeChanges(base, next)).toEqual([
      { label: 'Voice', from: 'on-device', to: 'remote' },
      { label: 'Prices for gpt-5.6-luna', from: 'input 1.5, output 12', to: '(defaults)' },
    ])
  })
})
