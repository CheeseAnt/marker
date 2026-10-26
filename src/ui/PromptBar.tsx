import { useState } from 'react'

export function PromptBar() {
  const [text, setText] = useState('')

  return (
    <form
      className="prompt-bar"
      onSubmit={(e) => {
        e.preventDefault()
        // Wired to the edit orchestrator in phase 5.
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Describe a change, e.g. “add a database below the API and connect them”"
      />
      <button type="button" disabled title="Voice input arrives in phase 7">
        🎤
      </button>
      <button type="submit" disabled={!text.trim()}>
        Send
      </button>
    </form>
  )
}
