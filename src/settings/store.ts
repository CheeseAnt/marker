import { create } from 'zustand'
import { settingsSchema, type ProviderId, type Secrets, type Settings } from './schema'

const SETTINGS_KEY = 'boardbot.settings'
const SECRETS_KEY = 'boardbot.secrets'

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable (private mode, quota); settings stay in memory.
  }
}

function loadSettings(): Settings {
  const parsed = settingsSchema.safeParse(readJson(SETTINGS_KEY) ?? {})
  return parsed.success ? parsed.data : settingsSchema.parse({})
}

interface SettingsState {
  settings: Settings
  secrets: Secrets
  update: (patch: (s: Settings) => Settings) => void
  setApiKey: (provider: ProviderId, apiKey: string) => void
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: loadSettings(),
  secrets: (readJson(SECRETS_KEY) as Secrets | undefined) ?? {},
  update: (patch) => {
    const settings = settingsSchema.parse(patch(get().settings))
    writeJson(SETTINGS_KEY, settings)
    set({ settings })
  },
  setApiKey: (provider, apiKey) => {
    const secrets = { ...get().secrets, [provider]: { apiKey } }
    writeJson(SECRETS_KEY, secrets)
    set({ secrets })
  },
}))

export function hasApiKey(secrets: Secrets, provider: ProviderId): boolean {
  return Boolean(secrets[provider]?.apiKey)
}
