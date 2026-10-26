import { parseBoard } from '../dsl/parse'
import type { LibraryEntry } from './library'

export const LIBRARY_FILE_SCHEMA = 'boardbot-library'
export const LIBRARY_FILE_VERSION = 1

export class LibraryFileError extends Error {}

/** Every template and version in the library, as board text, to share or back up. */
export function exportLibrary(entries: Record<string, LibraryEntry>, now = new Date()): string {
  const templates = Object.values(entries).map((e) => ({ name: e.name, versions: e.versions.map(({ version, text }) => ({ version, text })) }))
  return JSON.stringify({ schema: LIBRARY_FILE_SCHEMA, version: LIBRARY_FILE_VERSION, exportedAt: now.toISOString(), templates }, null, 2) + '\n'
}

export interface ImportedTemplate {
  name: string
  version: number
  text: string
}

/** Reads a library file and checks that each version is a template board of its name. */
export function parseLibraryFile(text: string): ImportedTemplate[] {
  let data: { schema?: unknown; version?: unknown; templates?: unknown }
  try {
    data = JSON.parse(text)
  } catch {
    throw new LibraryFileError("This file isn't a BoardBot template library (it isn't valid JSON).")
  }
  if (data?.schema !== LIBRARY_FILE_SCHEMA || !Array.isArray(data.templates)) throw new LibraryFileError("This file isn't a BoardBot template library.")
  if (typeof data.version !== 'number' || data.version > LIBRARY_FILE_VERSION) {
    throw new LibraryFileError('This template library is from a newer version of BoardBot. Update BoardBot to import it.')
  }
  const out: ImportedTemplate[] = []
  for (const t of data.templates as { name?: unknown; versions?: unknown }[]) {
    if (typeof t.name !== 'string' || !Array.isArray(t.versions)) throw new LibraryFileError('A template in this library is damaged.')
    for (const v of t.versions as { version?: unknown; text?: unknown }[]) {
      if (typeof v.version !== 'number' || typeof v.text !== 'string') throw new LibraryFileError(`A version of ${t.name} is damaged.`)
      let board
      try {
        board = parseBoard(v.text)
      } catch (e) {
        throw new LibraryFileError(`${t.name} version ${v.version} can't be read: ${(e as Error).message}`)
      }
      if (board.template?.name !== t.name) throw new LibraryFileError(`${t.name} version ${v.version} isn't a template named ${t.name}.`)
      out.push({ name: t.name, version: v.version, text: v.text })
    }
  }
  return out
}
