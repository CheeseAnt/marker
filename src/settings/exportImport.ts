import { settingsSchema, type Secrets, type Settings } from './schema'

export const SETTINGS_FILE_SCHEMA = 'boardbot-settings'
export const SETTINGS_FILE_VERSION = 1

/** Each step upgrades raw settings from version n to n + 1. Add one whenever the shape changes. */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>
export const MIGRATIONS: Record<number, Migration> = {}

/** Field names that must never appear in an export, whatever the schema says. */
const SECRET_NAME = /(api[-_]?key|secret|password|token$)/i

function secretPaths(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(SECRET_NAME.test(k) ? [`${path}${k}`] : []),
    ...secretPaths(v, `${path}${k}.`),
  ])
}

export class SettingsFileError extends Error {}

/**
 * The settings as a file to download. Keys live apart from settings so they can't be included;
 * as a second guard, the output is checked for anything key-like or for a stored key's value.
 */
export function exportSettings(settings: Settings, secrets: Secrets, now = new Date()): string {
  const file = { schema: SETTINGS_FILE_SCHEMA, version: SETTINGS_FILE_VERSION, exportedAt: now.toISOString(), settings: settingsSchema.parse(settings) }
  const text = JSON.stringify(file, null, 2)
  const leaks = secretPaths(file.settings)
  const keyValues = Object.values(secrets).flatMap((s) => (s?.apiKey ? [s.apiKey] : []))
  if (leaks.length || keyValues.some((k) => k && text.includes(k))) {
    throw new SettingsFileError('Settings could not be exported without including an API key, so nothing was exported.')
  }
  return text + '\n'
}

export function migrateSettings(raw: Record<string, unknown>, from: number, migrations: Record<number, Migration> = MIGRATIONS): Record<string, unknown> {
  let current = raw
  for (let v = from; v < SETTINGS_FILE_VERSION; v++) {
    const step = migrations[v]
    if (!step) throw new SettingsFileError(`Settings from version ${from} can't be read by this version of BoardBot.`)
    current = step(current)
  }
  return current
}

/** Reads a settings file; throws SettingsFileError with a message for the user. */
export function parseSettingsFile(text: string, migrations: Record<number, Migration> = MIGRATIONS): Settings {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new SettingsFileError("This file isn't a BoardBot settings file (it isn't valid JSON).")
  }
  const file = data as { schema?: unknown; version?: unknown; settings?: unknown }
  if (file?.schema !== SETTINGS_FILE_SCHEMA || typeof file.settings !== 'object' || file.settings === null) {
    throw new SettingsFileError("This file isn't a BoardBot settings file.")
  }
  const version = typeof file.version === 'number' ? file.version : NaN
  if (!Number.isInteger(version) || version < 0) throw new SettingsFileError('This settings file has no valid version number.')
  if (version > SETTINGS_FILE_VERSION) {
    throw new SettingsFileError(`This settings file is from a newer version of BoardBot (format ${version}). Update BoardBot to import it.`)
  }
  const raw = migrateSettings(file.settings as Record<string, unknown>, version, migrations)
  // Keys are never imported, even from a hand-edited file.
  const leaks = secretPaths(raw)
  if (leaks.length) throw new SettingsFileError(`This file contains ${leaks.join(', ')}. Remove it; API keys are entered in Settings, not imported.`)
  const parsed = settingsSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new SettingsFileError(`This settings file has an invalid value at ${issue.path.join('.') || 'the top level'}: ${issue.message}`)
  }
  return parsed.data
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k] as Record<string, unknown>, v) : v
  return out
}

/**
 * 'replace' takes the file as it is; 'merge' only changes what the file sets, so prices for
 * deployments the file doesn't mention are kept.
 */
export function combineSettings(current: Settings, incoming: Settings, raw: Record<string, unknown>, mode: 'replace' | 'merge'): Settings {
  return mode === 'replace' ? incoming : settingsSchema.parse(deepMerge(current as unknown as Record<string, unknown>, raw))
}

/** The raw settings object in a file, after migration, for merging. */
export function rawSettingsOf(text: string, migrations: Record<number, Migration> = MIGRATIONS): Record<string, unknown> {
  const file = JSON.parse(text) as { version: number; settings: Record<string, unknown> }
  return migrateSettings(file.settings, file.version, migrations)
}

const LABELS: [string, string][] = [
  ['providers.azure-foundry.endpoint', 'Endpoint URL'],
  ['providers.azure-foundry.deployment', 'Deployment'],
  ['providers.azure-foundry.endpointStyle', 'Endpoint type'],
  ['providers.azure-foundry.apiVersion', 'API version'],
  ['providers.azure-foundry.transcriptionDeployment', 'Transcription deployment'],
  ['voice.mode', 'Voice'],
  ['voice.onDeviceModel', 'Speech model'],
  ['voice.autoSend', 'Send spoken requests straight away'],
  ['shortcuts.focusPrompt', 'Jump to the prompt bar'],
  ['shortcuts.pushToTalk', 'Hold to talk'],
  ['jobConcurrency', 'Requests at once'],
  ['budget.warnAt', 'Monthly warning ($)'],
  ['budget.limit', 'Monthly limit ($)'],
]

function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), obj)
}

function show(v: unknown): string {
  if (v === '' || v === undefined) return '(empty)'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  return String(v)
}

export interface SettingChange {
  label: string
  from: string
  to: string
}

/** What importing would change, in words, for the review step. */
export function describeChanges(current: Settings, next: Settings): SettingChange[] {
  const changes: SettingChange[] = []
  for (const [path, label] of LABELS) {
    const a = at(current, path)
    const b = at(next, path)
    if (a !== b) changes.push({ label, from: show(a), to: show(b) })
  }
  const deployments = new Set([...Object.keys(current.pricing), ...Object.keys(next.pricing)])
  for (const d of deployments) {
    const a = JSON.stringify(current.pricing[d] ?? null)
    const b = JSON.stringify(next.pricing[d] ?? null)
    if (a === b) continue
    const fmt = (p: Settings['pricing'][string] | undefined) =>
      p ? Object.entries(p).map(([k, v]) => `${k} ${v}`).join(', ') || '(defaults)' : '(defaults)'
    changes.push({ label: `Prices for ${d}`, from: fmt(current.pricing[d]), to: fmt(next.pricing[d]) })
  }
  return changes
}
