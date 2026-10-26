import { useToast } from '../state/toast'

/** One message at a time above the ledge: what just changed, an answer, or what went wrong. */
export function ToastSlot() {
  const toast = useToast((s) => s.toast)
  const dismiss = useToast((s) => s.dismiss)
  if (!toast) return null
  return (
    <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
      <div className="toast-body">
        {toast.prompt && <p className="toast-prompt">{toast.prompt}</p>}
        <p className="toast-text">{toast.text}</p>
      </div>
      <div className="toast-actions">
        {toast.action && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              dismiss(toast.id)
              toast.action!.run()
            }}
          >
            {toast.action.label}
          </button>
        )}
        <button type="button" className="toast-dismiss" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
          ×
        </button>
      </div>
    </div>
  )
}
