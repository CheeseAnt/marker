import { z } from 'zod'

export const azureFoundrySettings = z.object({
  endpoint: z.string().default(''),
  deployment: z.string().default(''),
  apiVersion: z.string().default('2024-10-21'),
  transcriptionDeployment: z.string().default(''),
})

export const voiceSettings = z.object({
  mode: z.enum(['on-device', 'remote', 'browser', 'off']).default('on-device'),
  onDeviceModel: z
    .enum(['moonshine-base', 'moonshine-tiny', 'whisper-base.en', 'whisper-small.en'])
    .default('moonshine-base'),
  autoSend: z.boolean().default(false),
})

export const settingsSchema = z.object({
  activeProvider: z.literal('azure-foundry').default('azure-foundry'),
  providers: z
    .object({ 'azure-foundry': azureFoundrySettings.prefault({}) })
    .prefault({}),
  voice: voiceSettings.prefault({}),
  jobConcurrency: z.number().int().min(1).max(8).default(2),
})

export type Settings = z.infer<typeof settingsSchema>
export type ProviderId = Settings['activeProvider']

// API keys are kept apart from settings so settings export can never include them.
export type Secrets = Partial<Record<ProviderId, { apiKey?: string }>>
