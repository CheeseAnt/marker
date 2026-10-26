import { diffScene } from '../compile/fromExcalidraw'
import type { ExElement } from '../compile/exTypes'
import { compileBoard } from '../compile/toExcalidraw'
import { parseBoard } from '../dsl/parse'
import { printBoard } from '../dsl/print'
import { commit } from '../model/apply'
import { emptyBoard, type Board } from '../model/types'
import { debounce, deleteLegacyScene, loadBoardText, loadLegacyScene, quarantineBoardText, saveBoardText } from '../storage/idb'
import { useBoard } from './board'

/** Reads an Excalidraw scene into a board by treating every element as hand-drawn. */
export function boardFromScene(elements: readonly unknown[], title = 'Untitled'): Board {
  const board = emptyBoard(title)
  const ops = diffScene({ board, compiled: compileBoard(board), scene: elements as ExElement[] })
  return commit(board, ops).board
}

/** Loads the saved board (migrating the phase 1 autosave), then saves on every change. */
export async function startPersistence(onError: (message: string) => void): Promise<() => void> {
  const text = await loadBoardText()
  if (text !== undefined) {
    try {
      useBoard.getState().load(parseBoard(text))
    } catch (e) {
      await quarantineBoardText(text)
      onError(`Saved board could not be read and was set aside: ${(e as Error).message}`)
    }
  } else {
    const legacy = await loadLegacyScene()
    if (legacy) {
      try {
        useBoard.getState().load(boardFromScene(legacy))
        await saveBoardText(printBoard(useBoard.getState().board))
        await deleteLegacyScene()
      } catch (e) {
        onError(`Previous drawing could not be converted: ${(e as Error).message}`)
      }
    }
  }

  const save = debounce((board: Board) => {
    saveBoardText(printBoard(board)).catch((e) => onError(`Autosave failed: ${(e as Error).message}`))
  }, 400)
  return useBoard.subscribe((state, prev) => {
    if (state.board !== prev.board) save(state.board)
  })
}
