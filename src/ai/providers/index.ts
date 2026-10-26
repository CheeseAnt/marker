import type { Secrets, Settings } from '../../settings/schema'
import { createAzureFoundryProvider } from './azureFoundry'
import type { LLMProvider } from './types'

export const PROVIDER_LABELS: Record<Settings['activeProvider'], string> = { 'azure-foundry': 'Azure AI Foundry' }

/** The provider the settings select, built from the current settings and stored key. */
export function createProvider(settings: Settings, secrets: Secrets, fetchImpl?: typeof fetch): LLMProvider {
  switch (settings.activeProvider) {
    case 'azure-foundry': {
      const s = settings.providers['azure-foundry']
      return createAzureFoundryProvider({ ...s, apiKey: secrets['azure-foundry']?.apiKey ?? '' }, fetchImpl)
    }
  }
}

/** Whether the active provider has everything it needs to make a request. */
export function isProviderReady(settings: Settings, secrets: Secrets): boolean {
  const s = settings.providers[settings.activeProvider]
  return Boolean(s.endpoint.trim() && (s.deployment.trim() || /\/deployments\//.test(s.endpoint)) && secrets[settings.activeProvider]?.apiKey?.trim())
}
