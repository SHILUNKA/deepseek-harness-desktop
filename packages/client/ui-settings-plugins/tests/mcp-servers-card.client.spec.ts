import { describe, expect, it } from 'vitest'
import { serverLinesField } from '../src/client/mcp-servers-card-controller.ts'

const field = serverLinesField('servers')

describe('MCP server lines', () => {
  it('reads one server per line', () => {
    expect(field.parse('fs: npx -y @modelcontextprotocol/server-filesystem /docs'))
      .toEqual({
        kind: 'set',
        value: [{
          name: 'fs',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/docs'],
          enabled: true,
        }],
      })
  })

  it('keeps a quoted argument in one piece', () => {
    // A path with a space is ordinary on macOS and Windows; splitting on
    // whitespace alone would hand the server two arguments it cannot use.
    const parsed = field.parse('fs: npx server "/Users/a b/My Documents"')
    expect(parsed).toEqual({
      kind: 'set',
      value: [{ name: 'fs', command: 'npx', args: ['server', '/Users/a b/My Documents'], enabled: true }],
    })
  })

  it('treats a leading hash as kept but not running', () => {
    expect(field.parse('#parked: npx server')).toEqual({
      kind: 'set',
      value: [{ name: 'parked', command: 'npx', args: ['server'], enabled: false }],
    })
  })

  it('round-trips through the rendered text', () => {
    const text = 'fs: npx "/My Docs"\n#off: node server.js'
    const parsed = field.parse(text)
    expect(parsed?.kind).toBe('set')
    expect(field.format(parsed?.kind === 'set' ? parsed.value : undefined)).toBe(text)
  })

  it('clears the list when every line is blank', () => {
    expect(field.parse('   \n\n')).toEqual({ kind: 'clear' })
  })

  it.each([
    ['a line with no command name', 'no-colon-here'],
    ['an empty name', ': npx server'],
    ['a name with a space', 'my server: npx server'],
    ['a name over 32 characters', `${'x'.repeat(33)}: npx server`],
    ['a name used twice', 'fs: npx one\nfs: npx two'],
    ['a name with no command after it', 'fs:   '],
  ])('refuses %s, so the save is blocked rather than the server dropped', (_label, text) => {
    expect(field.parse(text)).toBeUndefined()
  })
})
