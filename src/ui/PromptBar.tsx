import { useEffect, useRef, useState } from 'react'
import { isProviderReady } from '../ai/providers'
import { isPending, useJobs } from '../jobs/queue'
import { useSettings } from '../settings/store'
import { canvasSelection } from '../state/canvasBridge'

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.matches('input, textarea, select, [contenteditable="true"]') || el.isContentEditable)
}

/** The marker ledge: requests are written here, in the board's handwriting. */
export function PromptBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const ready = useSettings((s) => isProviderReady(s.settings, s.secrets))
  const focusKey = useSettings((s) => s.settings.shortcuts.focusPrompt)
  const busy = useJobs((s) => s.jobs.some(isPending))

  // The focus shortcut works from anywhere except while typing in another field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== focusKey || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (document.querySelector('dialog[open]')) return
      e.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusKey])

  return (
    <form
      className="ledge"
      data-busy={busy || undefined}
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready) return onOpenSettings()
        const prompt = text.trim()
        if (!prompt) return
        // The selection at the moment of sending is what "this" refers to.
        useJobs.getState().submit(prompt, { selection: canvasSelection() })
        setText('')
      }}
    >
      <div className="ledge-field">
        <input
          ref={input}
          id="prompt-input"
          className="ledge-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.currentTarget.blur()
              document.querySelector<HTMLElement>('.excalidraw')?.focus()
            }
          }}
          aria-label="Describe a change to the board"
          aria-keyshortcuts={focusKey}
          placeholder="Add a database below the API and connect them"
        />
        {!focused && !text && (
          <kbd className="ledge-shortcut" aria-hidden="true" title={`Press ${focusKey} to write a request`}>
            {focusKey}
          </kbd>
        )}
      </div>
      <button type="button" className="ledge-button icon" disabled aria-label="Speak a change" title="Voice input isn't available yet">
        <MicIcon />
      </button>
      <button
        type="submit"
        className="ledge-button primary"
        disabled={ready && !text.trim()}
        title={ready ? 'Draw this change' : 'Set up a model in Settings first'}
      >
        Draw
      </button>
    </form>
  )
}
