import { useState } from 'react'

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

/** The marker ledge: requests are written here, in the board's handwriting. */
export function PromptBar() {
  const [text, setText] = useState('')

  return (
    <form
      className="ledge"
      onSubmit={(e) => {
        e.preventDefault()
        // Sent to the edit pipeline once a model provider is wired up.
      }}
    >
      <input
        className="ledge-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Describe a change to the board"
        placeholder="Add a database below the API and connect them"
      />
      <button type="button" className="ledge-button icon" disabled aria-label="Speak a change" title="Voice input isn't available yet">
        <MicIcon />
      </button>
      <button type="submit" className="ledge-button primary" disabled title="Connect a model to draw from a description">
        Draw
      </button>
    </form>
  )
}
