import type { ChangeSource, Transaction } from '../history/history'
import { useBoard } from '../state/board'

const SOURCE_LABELS: Record<ChangeSource, string> = {
  manual: 'Canvas',
  text: 'Board text',
  ai: 'Request',
  voice: 'Spoken request',
  system: 'BoardBot',
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function Row({ tx, state, onSelect }: { tx: Transaction; state: 'current' | 'past' | 'undone'; onSelect: () => void }) {
  return (
    <li>
      <button type="button" className={`history-row ${state}`} aria-current={state === 'current' ? 'step' : undefined} onClick={onSelect}>
        {tx.prompt ? <span className="history-prompt">{tx.prompt}</span> : null}
        <span className="history-title">{tx.title}</span>
        <span className="history-meta">
          {SOURCE_LABELS[tx.source]}, {time.format(tx.ts)}
          {state === 'undone' ? ', undone' : ''}
        </span>
      </button>
    </li>
  )
}

/** Every change, newest first. Selecting one returns the board to just after it. */
export function HistoryPanel() {
  const history = useBoard((s) => s.history)
  const jumpTo = useBoard((s) => s.jumpTo)
  const future = [...history.future].reverse()
  const past = [...history.past].reverse()
  const empty = past.length === 0 && future.length === 0

  const undo = useBoard((s) => s.undo)
  const redo = useBoard((s) => s.redo)

  return (
    <>
      <div className="drawer-header">
        <h2>History</h2>
        <span className="spacer" />
        <button type="button" disabled={past.length === 0} onClick={undo}>
          Undo
        </button>
        <button type="button" disabled={future.length === 0} onClick={redo}>
          Redo
        </button>
      </div>
      {empty ? (
        <p className="drawer-empty">Changes you make will be listed here, newest first. Select one to go back to it.</p>
      ) : (
        <ol className="history-list" aria-label="Changes, newest first">
          {future.map((tx) => (
            <Row key={tx.id} tx={tx} state="undone" onSelect={() => jumpTo(tx.id)} />
          ))}
          {past.map((tx, i) => (
            <Row key={tx.id} tx={tx} state={i === 0 ? 'current' : 'past'} onSelect={() => jumpTo(tx.id)} />
          ))}
          <li>
            <button
              type="button"
              className={`history-row origin ${past.length === 0 ? 'current' : 'past'}`}
              aria-current={past.length === 0 ? 'step' : undefined}
              onClick={() => jumpTo(null)}
            >
              <span className="history-title">Before these changes</span>
            </button>
          </li>
        </ol>
      )}
    </>
  )
}
