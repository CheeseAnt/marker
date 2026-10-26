import { get, set } from 'idb-keyval'
import { create } from 'zustand'
import { parseBoard } from '../dsl/parse'
import { printBoard } from '../dsl/print'
import type { Board } from '../model/types'
import type { TemplateVersion } from './operations'

const LIBRARY_KEY = 'boardbot.templates.v1'

/** Stored as text, the same format as boards, so a template can be read and copied by hand. */
interface StoredVersion {
  version: number
  text: string
  savedAt: number
}

export interface LibraryEntry {
  name: string
  versions: StoredVersion[]
}

interface LibraryState {
  entries: Record<string, LibraryEntry>
  loaded: boolean
  load: () => Promise<void>
  /**
   * Saves a template board as the next version of its name (or as `version`, when bringing in a
   * template from a board). Saving an unchanged board returns the version it already has.
   */
  save: (template: Board, version?: number) => TemplateVersion
  remove: (name: string) => void
}

const parsed = new Map<string, Board>()

function boardOf(v: StoredVersion): Board {
  let b = parsed.get(v.text)
  if (!b) {
    b = parseBoard(v.text)
    parsed.set(v.text, b)
  }
  return b
}

export function latestVersion(entry: LibraryEntry): TemplateVersion {
  const v = entry.versions.at(-1)!
  return { name: entry.name, version: v.version, board: boardOf(v) }
}

export function versionOf(entry: LibraryEntry, version: number): TemplateVersion | undefined {
  const v = entry.versions.find((x) => x.version === version)
  return v && { name: entry.name, version: v.version, board: boardOf(v) }
}

export const useLibrary = create<LibraryState>((setState, getState) => {
  const persist = () => {
    set(LIBRARY_KEY, getState().entries).catch(() => {
      // The library still works for this session; it just won't survive a reload.
    })
  }
  return {
    entries: {},
    loaded: false,
    load: async () => {
      try {
        const stored = await get<Record<string, LibraryEntry>>(LIBRARY_KEY)
        setState({ entries: stored ?? {}, loaded: true })
      } catch {
        setState({ loaded: true })
      }
    },
    save: (template, wanted) => {
      const name = template.template!.name
      const text = printBoard(template)
      const entry = getState().entries[name] ?? { name, versions: [] }
      const same = entry.versions.find((v) => v.text === text && (wanted === undefined || v.version === wanted))
      if (same) return { name, version: same.version, board: boardOf(same) }
      const taken = new Set(entry.versions.map((v) => v.version))
      const version = wanted !== undefined && !taken.has(wanted) ? wanted : Math.max(0, ...taken) + 1
      const stored = { version, text, savedAt: Date.now() }
      const next = { ...entry, versions: [...entry.versions, stored].sort((a, b) => a.version - b.version) }
      setState({ entries: { ...getState().entries, [name]: next } })
      persist()
      return { name, version, board: boardOf(stored) }
    },
    remove: (name) => {
      const entries = { ...getState().entries }
      delete entries[name]
      setState({ entries })
      persist()
    },
  }
})
