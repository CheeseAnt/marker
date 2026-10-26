import { useRef, useState } from 'react'
import { parseTemplateKey, templateKey, type Board, type InstanceElement } from '../model/types'
import { useBoard } from '../state/board'
import { canvasSelection, highlightAfterRender, viewportCenter } from '../state/canvasBridge'
import { useToast } from '../state/toast'
import { latestVersion, useLibrary, type LibraryEntry } from '../templates/library'
import { collectDefinitions, insertCopyOps, updateCopiesOps, type TemplateVersion } from '../templates/operations'
import { TemplatePreview } from './TemplatePreview'
import { exportLibrary, LibraryFileError, parseLibraryFile } from '../templates/libraryFile'

function list(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
}

function addToBoard(t: TemplateVersion) {
  const { board, apply } = useBoard.getState()
  // Next to what is selected, or in the middle of the view.
  const selected = canvasSelection()[0]
  const at = selected
    ? ({ kind: 'rel', dir: 'right', of: selected, gap: 80 } as const)
    : (() => {
        const c = viewportCenter()
        return { kind: 'at', x: Math.round(c.x), y: Math.round(c.y) } as const
      })()
  const ops = insertCopyOps(board, t, { at })
  const id = ops.at(-1)!.op === 'add' ? (ops.at(-1) as { element: { id: string } }).element.id : ''
  apply(ops, 'manual', { title: `Added a copy of “${t.name}”` })
  highlightAfterRender([id])
}

function updateCopies(t: TemplateVersion) {
  const { board, apply } = useBoard.getState()
  const report = updateCopiesOps(board, t)
  apply(report.ops, 'manual', { title: `Updated ${report.copies.length === 1 ? 'a copy' : `${report.copies.length} copies`} of “${t.name}” to version ${t.version}` })
  highlightAfterRender(report.copies)
  if (report.dropped.length) {
    useToast.getState().show({ kind: 'error', text: `Version ${t.version} has no place for: ${list(report.dropped)}. Undo to keep the old version.` })
  }
}

function Entry({ entry, copies }: { entry: LibraryEntry; copies: InstanceElement[] }) {
  const latest = latestVersion(entry)
  const spec = latest.board.template!
  const [confirming, setConfirming] = useState(false)
  const outdated = copies.filter((c) => c.template !== templateKey(entry.name, latest.version))
  return (
    <li className="template-entry">
      <TemplatePreview cacheKey={templateKey(entry.name, latest.version)} board={latest.board} />
      <div className="template-info">
        <p className="template-name">
          {latest.board.title} <span className="template-version">{entry.name}, version {latest.version}</span>
        </p>
        {spec.description && <p className="template-description">{spec.description}</p>}
        <p className="template-meta">
          {spec.params.length ? `Fill in ${list(spec.params.map((p) => p.name))}.` : 'Nothing to fill in.'}{' '}
          {spec.ports.length ? `Connects at ${list(spec.ports.map((p) => p.name))}.` : ''}
          {copies.length ? ` ${copies.length === 1 ? 'One copy' : `${copies.length} copies`} on this board.` : ''}
        </p>
        <div className="template-actions">
          <button type="button" className="primary" onClick={() => addToBoard(latest)}>
            Add to board
          </button>
          {outdated.length > 0 && (
            <button type="button" onClick={() => updateCopies(latest)}>
              Update {outdated.length === 1 ? 'copy' : `${outdated.length} copies`} to version {latest.version}
            </button>
          )}
          {confirming ? (
            <span className="template-confirm" role="group" aria-label={`Delete ${entry.name}?`}>
              Delete from the library? Copies on boards keep working.
              <button type="button" onClick={() => useLibrary.getState().remove(entry.name)}>
                Delete
              </button>
              <button type="button" className="quiet" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" className="quiet" onClick={() => setConfirming(true)}>
              Delete…
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

function downloadText(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Export the whole library to a file, or bring templates in from one. */
function LibraryTransfer({ hasTemplates }: { hasTemplates: boolean }) {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <div className="template-transfer">
      <button type="button" disabled={!hasTemplates} onClick={() => downloadText(exportLibrary(useLibrary.getState().entries), 'marker-templates.boardlib')}>
        Export library
      </button>
      <button type="button" onClick={() => picker.current?.click()}>
        Import templates…
      </button>
      <input
        ref={picker}
        type="file"
        accept=".boardlib,application/json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          try {
            const added = useLibrary.getState().importVersions(parseLibraryFile(await file.text()))
            useToast.getState().show({
              kind: 'done',
              text: added ? `Added ${added === 1 ? 'one template version' : `${added} template versions`} from ${file.name}.` : `Your library already has everything in ${file.name}.`,
            })
          } catch (err) {
            useToast.getState().show({ kind: 'error', text: err instanceof LibraryFileError ? err.message : `Couldn't read ${file.name}.` })
          }
        }}
      />
    </div>
  )
}

/** The template library, plus templates this board uses that the library doesn't have. */
export function TemplatesPanel({ onSaveSelection }: { onSaveSelection: () => void }) {
  const entries = useLibrary((s) => s.entries)
  const board = useBoard((s) => s.board)
  const copies = board.elements.filter((e): e is InstanceElement => e.kind === 'instance')
  const names = Object.keys(entries).sort()
  const foreign = Object.keys(board.definitions).filter((key) => {
    const { name, version } = parseTemplateKey(key)
    return copies.some((c) => c.template === key) && !entries[name]?.versions.some((v) => v.version === version)
  })

  return (
    <>
      <div className="drawer-header">
        <h2>Templates</h2>
        <span className="spacer" />
        <button type="button" className="primary" onClick={onSaveSelection}>
          Save selection as template
        </button>
      </div>
      <div className="drawer-scroll">
        {names.length === 0 ? (
          <p className="drawer-empty">
            Select shapes on the board and save them as a template to reuse them. Each copy can have its own text, and you choose
            when copies move to a newer version.
          </p>
        ) : (
          <ul className="template-list">
            {names.map((name) => (
              <Entry key={name} entry={entries[name]} copies={copies.filter((c) => c.template.startsWith(`${name}@`))} />
            ))}
          </ul>
        )}
        <LibraryTransfer hasTemplates={names.length > 0} />
        {foreign.length > 0 && (
          <section className="template-foreign" aria-labelledby="foreign-heading">
            <h3 id="foreign-heading">Used on this board, not in your library</h3>
            <ul>
              {foreign.map((key) => (
                <li key={key}>
                  {key}
                  <button
                    type="button"
                    onClick={() => {
                      const needs: Board['definitions'] = {}
                      for (const el of board.definitions[key].elements) if (el.kind === 'instance') collectDefinitions(board, el.template, needs)
                      useLibrary.getState().save({ ...board.definitions[key], definitions: needs }, parseTemplateKey(key).version)
                    }}
                  >
                    Save to library
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  )
}
