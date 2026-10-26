import { useEffect, useState } from 'react'
import { parseBoard } from '../dsl/parse'
import { printBoard } from '../dsl/print'
import { DslError } from '../dsl/tokenize'
import { OpError } from '../model/apply'
import { diffBoards } from '../model/diffBoards'
import { useBoard } from '../state/board'

/** The board as text. Edits are applied as ordinary ops, so they can be undone like any other. */
export function BoardTextPanel() {
  const board = useBoard((s) => s.board)
  const printed = printBoard(board)
  const [draft, setDraft] = useState(printed)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Follow the board while the user is not editing the text.
  useEffect(() => {
    if (!dirty) setDraft(printed)
  }, [printed, dirty])

  const apply = () => {
    try {
      const next = parseBoard(draft)
      const ops = diffBoards(useBoard.getState().board, next)
      if (ops.length) useBoard.getState().apply(ops, 'text')
      setDirty(false)
      setError(null)
    } catch (e) {
      if (e instanceof DslError || e instanceof OpError) setError(e.message)
      else throw e
    }
  }

  return (
    <aside className="text-panel">
      <div className="text-panel-header">
        <h2>Board text</h2>
        <span className="spacer" />
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setDirty(false)
              setError(null)
            }}
          >
            Revert
          </button>
        )}
        <button type="button" className="primary" disabled={!dirty} onClick={apply} title="Apply (Ctrl+Enter)">
          Apply
        </button>
      </div>
      <textarea
        aria-label="Board text"
        spellCheck={false}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') apply()
          // Keep typing here from triggering canvas shortcuts.
          e.stopPropagation()
        }}
      />
      {error && <div className="text-panel-error">{error}</div>}
    </aside>
  )
}
