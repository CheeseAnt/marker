import { describe, expect, it } from 'vitest'
import { exportLibrary, parseLibraryFile } from './libraryFile'
import { useLibrary } from './library'

const server = (label: string) => `board "Server" v1\ntemplate server\n\nnode box "${label}" rect at(0,0)\n`

describe('template library files', () => {
  it('round-trips every version and merges without overwriting', () => {
    useLibrary.setState({ entries: { server: { name: 'server', versions: [{ version: 1, text: server('A'), savedAt: 1 }] } } })
    const text = exportLibrary(useLibrary.getState().entries)
    expect(parseLibraryFile(text)).toEqual([{ name: 'server', version: 1, text: server('A') }])
    // Libraries exported before the rename still import.
    expect(parseLibraryFile(text.replace('"marker-library"', '"boardbot-library"'))).toHaveLength(1)

    // Same version: skipped. Different content under a taken version number: added as the next.
    const added = useLibrary.getState().importVersions([
      { name: 'server', version: 1, text: server('A') },
      { name: 'server', version: 1, text: server('B') },
      { name: 'server', version: 4, text: server('C') },
    ])
    expect(added).toBe(2)
    expect(useLibrary.getState().entries.server.versions.map((v) => v.version)).toEqual([1, 2, 4])
  })

  it.each([
    ['nope', /isn't valid JSON/],
    ['{"schema":"marker-settings"}', /isn't a Marker template library/],
    ['{"schema":"marker-library","version":9,"templates":[]}', /newer version/],
    ['{"schema":"marker-library","version":1,"templates":[{"name":"x","versions":[{"version":1,"text":"board \\"X\\" v1\\n"}]}]}', /isn't a template named x/],
  ])('rejects %s', (text, message) => {
    expect(() => parseLibraryFile(text)).toThrow(message)
  })
})
