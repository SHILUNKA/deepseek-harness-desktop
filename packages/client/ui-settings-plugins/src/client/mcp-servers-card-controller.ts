/** The MCP card's staged form over the `mcp-servers` settings namespace. */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, type CardActions, type CardFieldSpec, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the managed MCP server list. Spelled here rather than imported:
 * a client package must not depend on a Host package.
 */
export const MCP_SERVERS_NS = 'mcp-servers'

/** One managed MCP server. */
interface McpServerEntry {
  name: string
  command: string
  args: string[]
  /**
   * Optional because a stored entry may predate the flag or omit it; the Host
   * schema defaults it to true, so only an explicit `false` means parked.
   */
  enabled?: boolean
}

/** The MCP fields this card edits. */
export interface McpServersSettings {
  /** Servers this installation manages. */
  servers?: McpServerEntry[]
}

/** Server names are the model-facing tool namespace, so the Host constrains them. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Split a command line into a command and its arguments, honouring double
 * quotes. A path with a space in it is ordinary on macOS and Windows, and
 * splitting on whitespace alone would silently tear one argument into two.
 * @param text - the command portion of one line.
 * @returns the tokens, with surrounding quotes removed.
 */
function tokenize(text: string): string[] {
  return (text.match(/"[^"]*"|\S+/g) ?? [])
    .map(token => token.startsWith('"') && token.endsWith('"') && token.length >= 2
      ? token.slice(1, -1)
      : token)
}

/**
 * The server list as one line per server: `name: command args…`, with a leading
 * `#` for one that is kept but not run.
 *
 * Lines rather than a row of controls per server, because a launch command is
 * something people paste from a README in one piece. A malformed line returns
 * undefined, which blocks the save and marks the control rather than dropping
 * the server silently.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function serverLinesField(field: string): CardFieldSpec {
  const isEntry = (value: unknown): value is McpServerEntry =>
    typeof value === 'object' && value !== null
    && typeof (value as McpServerEntry).name === 'string'
    && typeof (value as McpServerEntry).command === 'string'
  const quote = (token: string): string => token.includes(' ') ? `"${token}"` : token
  return {
    field,
    format: value => Array.isArray(value) && value.every(isEntry)
      ? value.map((entry) => {
        const args = Array.isArray(entry.args) ? entry.args.map(quote).join(' ') : ''
        const command = args === '' ? quote(entry.command) : `${quote(entry.command)} ${args}`
        return `${entry.enabled === false ? '#' : ''}${entry.name}: ${command}`
      }).join('\n')
      : '',
    parse: (text) => {
      const servers: McpServerEntry[] = []
      const seen = new Set<string>()
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (line === '') continue
        const enabled = !line.startsWith('#')
        const body = enabled ? line : line.slice(1).trim()
        const colon = body.indexOf(':')
        if (colon <= 0) return undefined
        const name = body.slice(0, colon).trim()
        if (!NAME_PATTERN.test(name) || seen.has(name)) return undefined
        const [command, ...args] = tokenize(body.slice(colon + 1))
        if (command === undefined) return undefined
        seen.add(name)
        servers.push({ name, command, args, enabled })
      }
      return servers.length === 0 ? { kind: 'clear' } : { kind: 'set', value: servers }
    },
  }
}

/** What the MCP card renders. */
export interface McpServersCardState extends CardShell {
  /** The managed server list. */
  servers: CardFieldState
}

/** The registration-side face the MCP card's slot entry injects. */
export interface McpServersCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useMcpServersCard. */
    mcpServersCard: SnapshotStore<McpServersCardState>
  }
}

/** Bridges the `mcp-servers` scope onto the card's staged form. */
export class McpServersCardController {
  private readonly form: CardForm<McpServersSettings>
  private readonly store: SnapshotStore<McpServersCardState>

  /** @param scope - the bound settings scope for the `mcp-servers` namespace. */
  constructor(scope: SettingsScope<McpServersSettings>) {
    this.form = new CardForm(scope, [serverLinesField('servers')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): McpServersCardState {
    return { ...this.form.shell(), servers: this.form.field('servers') }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): McpServersCardFace {
    return { hooks: { mcpServersCard: this.store }, ...this.form.actions() }
  }
}
