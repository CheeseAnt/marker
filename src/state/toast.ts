import { create } from 'zustand'

export interface Toast {
  id: number
  kind: 'done' | 'reply' | 'error'
  text: string
  /** Shown in the handwriting face above the text, e.g. the request it answers. */
  prompt?: string
  action?: { label: string; run: () => void }
}

interface ToastState {
  toast: Toast | null
  show: (toast: Omit<Toast, 'id'>) => void
  dismiss: (id?: number) => void
}

const AUTO_DISMISS_MS = 7000
let nextId = 1
let timer: ReturnType<typeof setTimeout> | undefined

export const useToast = create<ToastState>((set, get) => ({
  toast: null,
  show: (toast) => {
    const id = nextId++
    clearTimeout(timer)
    set({ toast: { ...toast, id } })
    // Confirmations fade on their own; answers and errors wait to be read.
    if (toast.kind === 'done') timer = setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS)
  },
  dismiss: (id) => {
    if (id === undefined || get().toast?.id === id) set({ toast: null })
  },
}))
