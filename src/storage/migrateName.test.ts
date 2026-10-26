import { describe, expect, it } from 'vitest'
import { migrateLocalStorage, renamedKey } from './migrateName'

function memoryStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

describe('moving data saved under the old name', () => {
  it('maps old keys to new ones and leaves others alone', () => {
    expect(renamedKey('boardbot.board.v1')).toBe('marker.board.v1')
    expect(renamedKey('boardbot.asset.ab12')).toBe('marker.asset.ab12')
    expect(renamedKey('marker.board.v1')).toBeUndefined()
    expect(renamedKey('other')).toBeUndefined()
    expect(renamedKey(3)).toBeUndefined()
  })

  it('moves settings and keys, keeping anything already saved under the new name', () => {
    const storage = memoryStorage({ 'boardbot.settings': '{"a":1}', 'boardbot.secrets': '{"k":1}', 'marker.secrets': '{"k":2}' })
    migrateLocalStorage(storage)
    expect(Object.fromEntries(storage.data)).toEqual({ 'marker.settings': '{"a":1}', 'marker.secrets': '{"k":2}' })
  })
})
