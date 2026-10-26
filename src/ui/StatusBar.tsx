import { hasApiKey, useSettings } from '../settings/store'

const PROVIDER_LABELS = { 'azure-foundry': 'Azure Foundry' } as const

export function StatusBar() {
  const settings = useSettings((s) => s.settings)
  const secrets = useSettings((s) => s.secrets)
  const provider = settings.activeProvider
  const config = settings.providers[provider]
  const configured = Boolean(config.endpoint && config.deployment)

  return (
    <div className="status-bar">
      <span>Mic: {settings.voice.mode === 'off' ? 'off' : settings.voice.onDeviceModel}</span>
      <span className={configured && hasApiKey(secrets, provider) ? '' : 'warn'}>
        Provider: {PROVIDER_LABELS[provider]}
        {!configured ? ' · not configured' : !hasApiKey(secrets, provider) ? ' · API key needed' : ` · ${config.deployment}`}
      </span>
      <span className="spacer" />
      <span>No active jobs</span>
      <span>Session: 0 tok · $0.00</span>
    </div>
  )
}
