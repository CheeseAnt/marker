import { useEffect, useId, useRef, useState } from 'react'
import { DEFAULT_API_VERSION, parseEndpoint, type EndpointStyle } from '../ai/providers/azureEndpoint'
import { createProvider, PROVIDER_LABELS } from '../ai/providers'
import { ProviderError, type ConnectionReport } from '../ai/providers/types'
import type { Settings } from '../settings/schema'
import { useSettings } from '../settings/store'
import { VoiceSettings } from './VoiceSettings'
import { CostSettings } from './CostSettings'
import { meterProvider } from '../usage/meter'

type Azure = Settings['providers']['azure-foundry']

const STYLE_LABELS: Record<Azure['endpointStyle'], string> = {
  auto: 'Detect from the URL',
  deployments: 'Azure OpenAI deployment (…openai.azure.com/openai/deployments)',
  v1: 'Azure OpenAI v1 (…openai.azure.com/openai/v1)',
  models: 'Foundry models (…services.ai.azure.com/models)',
}

function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

type TestState = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok'; report: ConnectionReport } | { kind: 'error'; message: string }

interface Props {
  open: boolean
  onClose: () => void
}

/** Model provider settings. Changes apply on Save; the API key never leaves this browser. */
export function SettingsDialog({ open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const saved = useSettings((s) => s.settings)
  const savedKey = useSettings((s) => s.secrets['azure-foundry']?.apiKey ?? '')
  const [azure, setAzure] = useState<Azure>(saved.providers['azure-foundry'])
  const [voice, setVoice] = useState(saved.voice)
  const [shortcuts, setShortcuts] = useState(saved.shortcuts)
  const [pricing, setPricing] = useState(saved.pricing)
  const [budget, setBudget] = useState(saved.budget)
  const [apiKey, setApiKey] = useState(savedKey)
  const [showKey, setShowKey] = useState(false)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const abort = useRef<AbortController | null>(null)
  const ids = { endpoint: useId(), deployment: useId(), key: useId(), style: useId(), version: useId(), hint: useId(), keyHint: useId() }

  // Opening starts from what is saved; closing cancels any running test.
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      setAzure(useSettings.getState().settings.providers['azure-foundry'])
      setVoice(useSettings.getState().settings.voice)
      setShortcuts(useSettings.getState().settings.shortcuts)
      setPricing(useSettings.getState().settings.pricing)
      setBudget(useSettings.getState().settings.budget)
      setApiKey(useSettings.getState().secrets['azure-foundry']?.apiKey ?? '')
      setShowKey(false)
      setTest({ kind: 'idle' })
      dialog.showModal()
    } else if (!open && dialog.open) {
      abort.current?.abort()
      dialog.close()
    }
  }, [open])

  const set = <K extends keyof Azure>(key: K, value: Azure[K]) => {
    setAzure((a) => ({ ...a, [key]: value }))
    setTest({ kind: 'idle' })
  }

  const parsed = parseEndpoint(azure.endpoint)
  const style: EndpointStyle | undefined = azure.endpointStyle === 'auto' ? parsed?.style : azure.endpointStyle
  const versionPlaceholder = style ? (DEFAULT_API_VERSION[style] ?? 'Not used by this endpoint type') : ''

  // A pasted request URL fills in the deployment and API version when those are empty.
  const absorbEndpoint = () => {
    if (!parsed) return
    setAzure((a) => ({
      ...a,
      deployment: a.deployment || parsed.deployment || '',
      apiVersion: a.apiVersion || parsed.apiVersion || '',
    }))
  }

  const draftSettings = (): Settings => ({ ...saved, voice, shortcuts, pricing, budget, providers: { ...saved.providers, 'azure-foundry': azure } })

  const runTest = async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setTest({ kind: 'running' })
    try {
      const provider = meterProvider(createProvider(draftSettings(), { 'azure-foundry': { apiKey } }), { deployment: azure.deployment })
      const report = await provider.testConnection(controller.signal)
      setTest({ kind: 'ok', report })
    } catch (e) {
      if (controller.signal.aborted) return
      setTest({ kind: 'error', message: e instanceof ProviderError ? e.message : String(e) })
    }
  }

  const save = () => {
    useSettings.getState().update(() => draftSettings())
    useSettings.getState().setApiKey('azure-foundry', apiKey.trim())
    onClose()
  }

  return (
    <dialog
      ref={ref}
      className="settings"
      aria-labelledby="settings-title"
      onClose={onClose}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
        </header>

        <section className="settings-section" aria-labelledby="provider-heading">
          <h3 id="provider-heading">Model</h3>
          <p className="settings-lede">
            BoardBot sends your requests and the board's text to this model. It connects straight from your browser; there's no
            BoardBot server in between.
          </p>

          <div className="field">
            <label htmlFor={ids.endpoint}>Endpoint URL</label>
            <input
              id={ids.endpoint}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://your-resource.openai.azure.com"
              aria-describedby={ids.hint}
              value={azure.endpoint}
              onChange={(e) => set('endpoint', e.target.value)}
              onBlur={absorbEndpoint}
            />
            <p id={ids.hint} className="field-hint">
              {azure.endpoint && !parsed
                ? 'This doesn’t look like an https URL.'
                : parsed && !style
                  ? 'Choose the endpoint type under Advanced; this URL doesn’t say which API it is.'
                  : 'Paste your resource URL, or any request URL from the Azure portal and the rest fills in.'}
            </p>
          </div>

          <div className="field">
            <label htmlFor={ids.deployment}>Deployment name</label>
            <input
              id={ids.deployment}
              autoComplete="off"
              spellCheck={false}
              placeholder="gpt-5.6-luna"
              value={azure.deployment}
              onChange={(e) => set('deployment', e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor={ids.key}>API key</label>
            <div className="field-row">
              <input
                id={ids.key}
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={ids.keyHint}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setTest({ kind: 'idle' })
                }}
              />
              <button type="button" className="quiet" aria-pressed={showKey} onClick={() => setShowKey((v) => !v)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <p id={ids.keyHint} className="field-hint">
              Stored only in this browser. It's never included when you export settings.
            </p>
          </div>

          <details className="settings-advanced">
            <summary>Advanced</summary>
            <div className="field">
              <label htmlFor={ids.style}>Endpoint type</label>
              <select id={ids.style} value={azure.endpointStyle} onChange={(e) => set('endpointStyle', e.target.value as Azure['endpointStyle'])}>
                {(Object.keys(STYLE_LABELS) as Azure['endpointStyle'][]).map((k) => (
                  <option key={k} value={k}>
                    {k === 'auto' && parsed?.style ? `${STYLE_LABELS.auto}: ${STYLE_LABELS[parsed.style].split(' (')[0]}` : STYLE_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={ids.version}>API version</label>
              <input
                id={ids.version}
                autoComplete="off"
                spellCheck={false}
                placeholder={versionPlaceholder}
                disabled={style === 'v1'}
                value={azure.apiVersion}
                onChange={(e) => set('apiVersion', e.target.value)}
              />
            </div>
          </details>

          <div className="settings-test">
            <button type="button" onClick={runTest} disabled={test.kind === 'running'}>
              {test.kind === 'running' ? 'Testing…' : 'Test connection'}
            </button>
            <p className={`settings-test-result ${test.kind}`} role="status" aria-live="polite">
              {test.kind === 'ok' &&
                `Connected${test.report.model ? ` to ${test.report.model}` : ''} in ${formatLatency(test.report.latencyMs)}. ${
                  test.report.toolCalling ? 'Tool calling works.' : 'This deployment didn’t call tools, so it can’t edit boards.'
                }`}
              {test.kind === 'error' && test.message}
            </p>
          </div>
        </section>

        <VoiceSettings
          voice={voice}
          shortcuts={shortcuts}
          transcriptionDeployment={azure.transcriptionDeployment}
          onVoice={setVoice}
          onShortcuts={setShortcuts}
          onTranscriptionDeployment={(d) => set('transcriptionDeployment', d)}
        />

        <CostSettings
          pricing={pricing}
          budget={budget}
          deployments={[
            { name: azure.deployment.trim(), kind: 'chat' },
            { name: azure.transcriptionDeployment.trim(), kind: 'transcribe' },
          ]}
          onPricing={setPricing}
          onBudget={setBudget}
        />

        <footer className="settings-footer">
          <span className="settings-provider-note">Provider: {PROVIDER_LABELS[saved.activeProvider]}</span>
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </footer>
      </form>
    </dialog>
  )
}
