import { useEffect, useId, useRef, useState } from 'react'
import { OpError } from '../model/apply'
import { portSides, type Board, type BoardElement, type Id, type PortSide } from '../model/types'
import { useBoard } from '../state/board'
import { highlightAfterRender } from '../state/canvasBridge'
import { useToast } from '../state/toast'
import { useLibrary } from '../templates/library'
import { expandSelection, replaceWithCopyOps, templateFromSelection, toIdentifier } from '../templates/operations'

interface Props {
  open: boolean
  /** Board ids selected when the dialog was opened. */
  selection: Id[]
  onClose: () => void
}

function textOf(el: BoardElement): string | undefined {
  return el.kind === 'node' ? el.label : el.kind === 'text' ? el.text : undefined
}

interface Choice {
  element: Id
  text: string
  on: boolean
  name: string
}

interface PortChoice {
  element: Id
  text: string
  on: boolean
  name: string
  side: PortSide
}

/** Turns the selection into a reusable template: its name, the text each copy fills in, and where edges attach. */
export function SaveTemplateDialog({ open, selection, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const entries = useLibrary((s) => s.entries)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [params, setParams] = useState<Choice[]>([])
  const [ports, setPorts] = useState<PortChoice[]>([])
  const [replace, setReplace] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const ids = { name: useId(), description: useId(), nameHint: useId() }

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      const board = useBoard.getState().board
      const picked = new Set(expandSelection(board, selection))
      const elements = board.elements.filter((e) => picked.has(e.id))
      const texts = elements.filter((e) => textOf(e))
      setName('')
      setDescription('')
      setError(null)
      setReplace(true)
      // The first labelled shape is the obvious thing for each copy to rename.
      setParams(texts.map((e, i) => ({ element: e.id, text: textOf(e)!, on: i === 0, name: i === 0 ? 'name' : toIdentifier(textOf(e)!, `text${i + 1}`) })))
      setPorts(
        elements
          .filter((e) => e.kind === 'node')
          .map((e, i) => ({ element: e.id, text: textOf(e) || e.id, on: i === 0, name: i === 0 ? 'in' : e.id, side: 'center' })),
      )
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open, selection])

  const identifier = toIdentifier(name, '')
  const existing = identifier ? entries[identifier] : undefined
  const nextVersion = (existing?.versions.at(-1)?.version ?? 0) + 1

  const save = () => {
    if (!identifier) return setError('Give the template a name.')
    const chosen = params.filter((p) => p.on)
    const paramNames = chosen.map((p) => p.name)
    if (paramNames.some((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) return setError('Fill-in names use letters, digits and underscores, like name or ip_address.')
    if (new Set(paramNames).size !== paramNames.length) return setError('Each fill-in needs its own name.')
    const portNames = ports.filter((p) => p.on).map((p) => p.name)
    if (portNames.some((n) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(n))) return setError('Connection point names use letters, digits, - and _.')
    if (new Set(portNames).size !== portNames.length) return setError('Each connection point needs its own name.')

    const board: Board = useBoard.getState().board
    const draft = {
      name: identifier,
      title: name.trim(),
      description: description.trim(),
      params: chosen.map((p) => ({ element: p.element, name: p.name })),
      ports: ports.filter((p) => p.on).map((p) => ({ element: p.element, name: p.name, side: p.side })),
    }
    try {
      const { template, bounds } = templateFromSelection(board, selection, draft)
      const saved = useLibrary.getState().save(template)
      if (replace) {
        const ops = replaceWithCopyOps(board, selection, saved, bounds)
        useBoard.getState().apply(ops, 'manual', { title: `Turned the selection into a copy of “${saved.name}”` })
        const copy = ops.find((o) => o.op === 'add')
        if (copy?.op === 'add') highlightAfterRender([copy.element.id])
      }
      useToast.getState().show({ kind: 'done', text: `Saved “${saved.board.title}” as version ${saved.version} in your templates.` })
      onClose()
    } catch (e) {
      setError(e instanceof OpError ? e.issues[0] : (e as Error).message)
    }
  }

  return (
    <dialog ref={ref} className="settings save-template" aria-labelledby="save-template-title" onClose={onClose} onKeyDown={(e) => e.stopPropagation()}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <header className="settings-header">
          <h2 id="save-template-title">Save as template</h2>
        </header>
        <section className="settings-section">
          <div className="field">
            <label htmlFor={ids.name}>Name</label>
            <input id={ids.name} autoComplete="off" placeholder="Web server" value={name} aria-describedby={ids.nameHint} onChange={(e) => setName(e.target.value)} />
            <p id={ids.nameHint} className="field-hint">
              {identifier
                ? existing
                  ? `Saves version ${nextVersion} of ${identifier}. Copies of earlier versions update when you choose.`
                  : `Appears in the board text as ${identifier}@1.`
                : 'A short name for what this is.'}
            </p>
          </div>
          <div className="field">
            <label htmlFor={ids.description}>Description</label>
            <input id={ids.description} autoComplete="off" placeholder="A web server with its disk" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          {params.length > 0 && (
            <fieldset className="choice-list">
              <legend>Text each copy fills in</legend>
              {params.map((p, i) => (
                <div key={p.element} className="choice-row">
                  <label className="choice-check">
                    <input type="checkbox" checked={p.on} onChange={(e) => setParams(params.map((q, j) => (j === i ? { ...q, on: e.target.checked } : q)))} />
                    <span className="choice-text">{p.text}</span>
                  </label>
                  {p.on && (
                    <input
                      aria-label={`Name for “${p.text}”`}
                      className="choice-name"
                      value={p.name}
                      onChange={(e) => setParams(params.map((q, j) => (j === i ? { ...q, name: e.target.value } : q)))}
                    />
                  )}
                </div>
              ))}
            </fieldset>
          )}

          {ports.length > 0 && (
            <fieldset className="choice-list">
              <legend>Where arrows connect</legend>
              {ports.map((p, i) => (
                <div key={p.element} className="choice-row">
                  <label className="choice-check">
                    <input type="checkbox" checked={p.on} onChange={(e) => setPorts(ports.map((q, j) => (j === i ? { ...q, on: e.target.checked } : q)))} />
                    <span className="choice-text">{p.text}</span>
                  </label>
                  {p.on && (
                    <>
                      <input
                        aria-label={`Connection name for “${p.text}”`}
                        className="choice-name"
                        value={p.name}
                        onChange={(e) => setPorts(ports.map((q, j) => (j === i ? { ...q, name: e.target.value } : q)))}
                      />
                      <select
                        aria-label={`Side of “${p.text}”`}
                        value={p.side}
                        onChange={(e) => setPorts(ports.map((q, j) => (j === i ? { ...q, side: e.target.value as PortSide } : q)))}
                      >
                        {portSides.map((s) => (
                          <option key={s} value={s}>
                            {s === 'center' ? 'any side' : s}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              ))}
            </fieldset>
          )}

          <label className="choice-check settings-replace">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace the selection with a copy of the template
          </label>
          {error && (
            <p className="settings-test-result error" role="alert">
              {error}
            </p>
          )}
        </section>
        <footer className="settings-footer">
          <span className="settings-provider-note" />
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save template
          </button>
        </footer>
      </form>
    </dialog>
  )
}
