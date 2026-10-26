import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../dsl/parse'
import { record, emptyHistory } from '../history/history'
import { commit } from '../model/apply'
import { assetIds, decodeBoardFile, decodeBoardText, encodeBoardText, encodeBoardZip } from './boardFile'

const board = parseBoard(`board "Files" v1

node api "API" rect at(0,0)
image logo asset:abc123 at(200,0) size(100,50)
`)
const asset = { id: 'abc123', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=', width: 100, height: 50, created: 1 }
const applied = commit(board, [{ op: 'update', id: 'api', set: { label: 'Gateway' } }])
const history = record(emptyHistory(), { id: 't1', ts: 1, source: 'manual', title: 'Renamed', ops: applied.ops, inverse: applied.inverse })
const file = { board: applied.board, assets: [{ ...asset, created: 0 }], history }
const strip = (f: ReturnType<typeof decodeBoardText>) => ({ ...f, assets: f.assets.map((a) => ({ ...a, created: 0 })) })

describe('board files', () => {
  it('finds images, including inside templates', () => {
    expect(assetIds(board)).toEqual(['abc123'])
  })

  it('round-trips the text format with images and history', () => {
    const text = encodeBoardText(file)
    expect(text).toMatch(/^board "Files" v1\n/)
    expect(text).toContain('\n\n#@asset abc123 image/png 100x50 iVBORw0KGgo=\n#@history ')
    expect(strip(decodeBoardText(text))).toEqual(file)
    // The board part alone is still ordinary board text.
    expect(parseBoard(text)).toEqual(applied.board)
  })

  it('round-trips the zip format', () => {
    expect(strip(decodeBoardFile(encodeBoardZip(file)))).toEqual(file)
  })

  it('drops history when the board text was edited by hand', () => {
    const edited = encodeBoardText(file).replace('"Gateway"', '"Edge"')
    const read = decodeBoardText(edited)
    expect(read.board.elements[0]).toMatchObject({ label: 'Edge' })
    expect(read.history).toBeUndefined()
  })

  it('reads plain board text without sections, and explains bad files', () => {
    expect(decodeBoardFile(strToU8('board "x" v1\n')).board.title).toBe('x')
    expect(() => decodeBoardFile(strToU8('PK\u0003\u0004garbage'))).toThrow(/not a valid zip/)
    expect(() => decodeBoardFile(strToU8('hello there'))).toThrow(/line 1/)
  })
})
