import { settingsSchema } from './schema'

export const DEFAULT_SHORTCUTS = settingsSchema.parse({}).shortcuts
