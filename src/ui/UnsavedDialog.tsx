import { useEffect, useRef } from 'react'
import { useFile } from '../state/file'
import { useUnsavedQuestion as useAsk, type UnsavedAnswer as Answer } from '../state/unsaved'

/** "Save your changes first?" before replacing a board that has unsaved changes. */
export function UnsavedDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const question = useAsk((s) => s.question)
  const name = useFile((s) => s.name)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (question && !dialog.open) dialog.showModal()
    if (!question && dialog.open) dialog.close()
  }, [question])

  const answer = (a: Answer) => {
    question?.resolve(a)
    useAsk.setState({ question: null })
  }

  return (
    <dialog ref={ref} className="settings unsaved" aria-labelledby="unsaved-title" onCancel={() => answer('cancel')} onKeyDown={(e) => e.stopPropagation()}>
      <div className="settings-section">
        <h2 id="unsaved-title">Save your changes first?</h2>
        <p className="settings-lede">
          {name ? `This board has changes that aren't saved to ${name}.` : "This board hasn't been saved to a file."} If you {question?.action ?? 'continue'}{' '}
          without saving, they will be lost.
        </p>
      </div>
      <footer className="settings-footer">
        <button type="button" className="quiet" onClick={() => answer('cancel')}>
          Cancel
        </button>
        <span className="spacer" />
        <button type="button" onClick={() => answer('discard')}>
          Don't save
        </button>
        <button type="button" className="primary" onClick={() => answer('save')}>
          Save
        </button>
      </footer>
    </dialog>
  )
}
