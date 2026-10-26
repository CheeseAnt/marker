import React, { useEffect, useRef, useState } from 'react'
import { isProviderReady } from '../ai/providers'
import { imageToAsset } from '../assets/image'
import { saveAsset, type Asset } from '../assets/store'
import { isPending, MAX_ATTACHMENTS, useJobs } from '../jobs/queue'
import { useToast } from '../state/toast'
import { parseShortcut, matchesShortcut } from '../speech/shortcut'
import { onTranscript, useVoice } from '../speech/voice'
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

function ClipIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
    </svg>
  )
}

interface Attached {
  asset: Asset
  name: string
}

function imageFiles(files: Iterable<File | null>): File[] {
  return [...files].filter((f): f is File => f !== null && f.type.startsWith('image/'))
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
  const [attached, setAttached] = useState<Attached[]>([])
  const [dropping, setDropping] = useState(false)
  const filePicker = useRef<HTMLInputElement>(null)
  const voiceOn = useSettings((s) => s.settings.voice.mode !== 'off')
  const autoSend = useSettings((s) => s.settings.voice.autoSend)
  const talkKey = useSettings((s) => s.settings.shortcuts.pushToTalk)
  const voice = useVoice((s) => s.status)
  const holdMode = useVoice((s) => s.holdMode)
  const level = useVoice((s) => s.level)

  const send = (prompt: string, source: 'ai' | 'voice') => {
    if (!ready) return onOpenSettings()
    if (!prompt.trim()) return
    // The selection at the moment of sending is what "this" refers to.
    useJobs.getState().submit(prompt.trim(), {
      source,
      selection: canvasSelection(),
      attachments: attached.map((a) => ({ assetId: a.asset.id, label: a.name })),
    })
    setText('')
    setAttached([])
  }
  const sendRef = useRef(send)
  sendRef.current = send

  // Spoken text joins whatever is already typed; with auto-send it goes straight to the model.
  useEffect(
    () =>
      onTranscript((spoken) => {
        const combined = [input.current?.value.trim(), spoken].filter(Boolean).join(' ')
        if (autoSend) sendRef.current(combined, 'voice')
        else {
          setText(combined)
          input.current?.focus()
        }
      }),
    [autoSend],
  )

  // Push-to-talk works everywhere, including while typing here, so it's a modifier combination.
  useEffect(() => {
    const shortcut = parseShortcut(talkKey)
    if (!shortcut || !voiceOn) return
    const down = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, shortcut) || document.querySelector('dialog[open]')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!e.repeat) useVoice.getState().press()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === shortcut.key || e.key === shortcut.key) useVoice.getState().release()
    }
    window.addEventListener('keydown', down, { capture: true })
    window.addEventListener('keyup', up, { capture: true })
    return () => {
      window.removeEventListener('keydown', down, { capture: true })
      window.removeEventListener('keyup', up, { capture: true })
    }
  }, [talkKey, voiceOn])

  const attach = async (files: File[]) => {
    const room = MAX_ATTACHMENTS - attached.length
    if (files.length > room) {
      useToast.getState().show({ kind: 'error', text: `A request can include up to ${MAX_ATTACHMENTS} images.` })
    }
    const added: Attached[] = []
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        const asset = await imageToAsset(file)
        await saveAsset(asset)
        added.push({ asset, name: file.name || 'pasted image' })
      } catch (e) {
        useToast.getState().show({ kind: 'error', text: `Couldn't attach ${file.name || 'that image'}: ${(e as Error).message}` })
      }
    }
    setAttached((current) => [...current, ...added].filter((a, i, all) => all.findIndex((b) => b.asset.id === a.asset.id) === i))
  }

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
      data-dropping={dropping || undefined}
      onDragOver={(e) => {
        if (![...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        const files = imageFiles(e.dataTransfer.files)
        setDropping(false)
        if (!files.length) return
        e.preventDefault()
        void attach(files)
      }}
      onSubmit={(e) => {
        e.preventDefault()
        send(text, 'ai')
      }}
    >
      {attached.length > 0 && (
        <ul className="ledge-attachments" aria-label="Attached images">
          {attached.map((a) => (
            <li key={a.asset.id} className="attachment">
              <img src={a.asset.dataURL} alt="" />
              <span className="attachment-name" title={a.name}>
                {a.name}
              </span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttached((current) => current.filter((b) => b.asset.id !== a.asset.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ledge-field">
        <input
          ref={input}
          id="prompt-input"
          className="ledge-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={(e) => {
            const files = imageFiles([...e.clipboardData.items].map((i) => (i.kind === 'file' ? i.getAsFile() : null)))
            if (!files.length) return
            e.preventDefault()
            void attach(files)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.currentTarget.blur()
              document.querySelector<HTMLElement>('.excalidraw')?.focus()
            }
          }}
          aria-label="Describe a change to the board"
          aria-keyshortcuts={focusKey}
          placeholder={
            voice === 'recording' || voice === 'starting'
              ? holdMode === 'hold'
                ? 'Listening… release to finish'
                : `Listening… press ${talkKey} or the microphone again to finish`
              : voice === 'transcribing'
                ? 'Turning speech into text…'
                : 'Add a database below the API and connect them'
          }
        />
        {!focused && !text && (
          <kbd className="ledge-shortcut" aria-hidden="true" title={`Press ${focusKey} to write a request`}>
            {focusKey}
          </kbd>
        )}
      </div>
      <input
        ref={filePicker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void attach(imageFiles(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      <button
        type="button"
        className="ledge-button icon"
        aria-label="Attach images"
        title="Attach images for the model to look at (you can also paste or drop them here)"
        onClick={() => filePicker.current?.click()}
      >
        <ClipIcon />
      </button>
      <button
        type="button"
        className="ledge-button icon mic"
        data-state={voice}
        style={{ '--level': level.toFixed(2) } as React.CSSProperties}
        disabled={!voiceOn || voice === 'transcribing'}
        aria-label={voice === 'recording' ? 'Stop recording' : 'Speak a change'}
        aria-pressed={voice === 'recording' || voice === 'starting'}
        aria-keyshortcuts={talkKey}
        title={voiceOn ? `Hold to speak, or tap to start and stop (${talkKey})` : 'Voice input is off; turn it on in Settings'}
        onPointerDown={(e) => {
          e.preventDefault()
          useVoice.getState().press()
        }}
        onPointerUp={() => useVoice.getState().release()}
        onPointerLeave={() => useVoice.getState().release()}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            if (!e.repeat) useVoice.getState().press()
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') useVoice.getState().release()
        }}
      >
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
