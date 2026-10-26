import { create } from 'zustand'
import { useBoard } from './board'
import { hasUnsavedChanges, newBoard, openBoard, saveBoard, useFile } from './file'

export type UnsavedAnswer = 'save' | 'discard' | 'cancel'

interface AskState {
  question: { action: string; resolve: (a: UnsavedAnswer) => void } | null
  ask: (action: string) => Promise<UnsavedAnswer>
}

/** The pending "save your changes first?" question, answered by UnsavedDialog. */
export const useUnsavedQuestion = create<AskState>((set) => ({
  question: null,
  ask: (action) => new Promise<UnsavedAnswer>((resolve) => set({ question: { action, resolve } })),
}))

/** Runs `then` once unsaved work is saved or knowingly discarded; does nothing if cancelled. */
async function afterSaving(action: string, then: () => void | Promise<void>) {
  const { board } = useBoard.getState()
  if (hasUnsavedChanges(board, useFile.getState().savedHash)) {
    const answer = await useUnsavedQuestion.getState().ask(action)
    if (answer === 'cancel') return
    if (answer === 'save' && !(await saveBoard())) return
  }
  await then()
}

export const newBoardAfterSaving = () => afterSaving('start a new board', newBoard)
export const openBoardAfterSaving = () => afterSaving('open another board', openBoard)
