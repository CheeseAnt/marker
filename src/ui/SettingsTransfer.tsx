import { useRef, useState } from 'react'
import { combineSettings, describeChanges, exportSettings, parseSettingsFile, rawSettingsOf, SettingsFileError, type SettingChange } from '../settings/exportImport'
import type { Settings } from '../settings/schema'
import { useSettings } from '../settings/store'

interface Pending {
  name: string
  text: string
  incoming: Settings
}

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'marker-settings.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Export and import buttons for the settings footer. */
export function SettingsTransferButtons({ draft, onPicked, onError }: { draft: () => Settings; onPicked: (p: Pending) => void; onError: (m: string) => void }) {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <span className="settings-transfer">
      <button
        type="button"
        className="quiet"
        title="Download these settings, without your API key"
        onClick={() => {
          try {
            download(exportSettings(draft(), useSettings.getState().secrets))
          } catch (e) {
            onError((e as Error).message)
          }
        }}
      >
        Export settings
      </button>
      <button type="button" className="quiet" onClick={() => picker.current?.click()}>
        Import settings…
      </button>
      <input
        ref={picker}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          const text = await file.text()
          try {
            onPicked({ name: file.name, text, incoming: parseSettingsFile(text) })
          } catch (err) {
            onError(err instanceof SettingsFileError ? err.message : `Couldn't read ${file.name}: ${(err as Error).message}`)
          }
        }}
      />
    </span>
  )
}

/** What an import would change, with the choice to replace everything or only what the file sets. */
export function ImportReview({ pending, current, onApply, onCancel }: { pending: Pending; current: Settings; onApply: (s: Settings) => void; onCancel: () => void }) {
  const [mode, setMode] = useState<'replace' | 'merge'>('replace')
  const next = combineSettings(current, pending.incoming, rawSettingsOf(pending.text), mode)
  const changes: SettingChange[] = describeChanges(current, next)
  return (
    <section className="settings-section import-review" aria-labelledby="import-heading">
      <h3 id="import-heading">Import {pending.name}</h3>
      {changes.length === 0 ? (
        <p className="settings-lede">These settings match yours; nothing would change.</p>
      ) : (
        <ul className="import-changes">
          {changes.map((c) => (
            <li key={c.label}>
              <span className="import-label">{c.label}</span> <span className="import-from">{c.from}</span> → <span className="import-to">{c.to}</span>
            </li>
          ))}
        </ul>
      )}
      <fieldset className="choice-list">
        <legend>How to import</legend>
        <label className="choice-check">
          <input type="radio" name="import-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
          Replace all settings with the file's
        </label>
        <label className="choice-check">
          <input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
          Only change what the file sets
        </label>
      </fieldset>
      <p className="field-hint">Your API key stays as it is; settings files never contain one.</p>
      <div className="import-actions">
        <button type="button" className="primary" onClick={() => onApply(next)}>
          Use these settings
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          Don't import
        </button>
      </div>
    </section>
  )
}

export type { Pending as PendingImport }
