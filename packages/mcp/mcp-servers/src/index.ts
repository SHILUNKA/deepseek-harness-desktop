/**
 * Settings-driven MCP server management.
 *
 * An MCP server is a plugin instance, not a value: adding one means putting a
 * row into the composition, which is a file a person has to find, a patch
 * dialect they have to learn, and a package name they have to know. This plugin
 * turns that row into a settings entry and mounts one `mcp-client` per entry
 * itself, so a settings surface — or a hand edit of `settings.yaml` — is enough
 * to gain or lose a server.
 *
 * Composition still owns servers a deployment ships. Those rows stay in
 * `cordis.yml`, unaffected; this manages only the ones a person added.
 *
 * @module @deepseek-ai/dsh-mcp-servers
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'mcp-servers'

/** Namespace the managed server list is edited under. */
export const MCP_SERVERS_NAMESPACE = settingsNamespace('mcp-servers')

/** One managed MCP server. */
export interface McpServerEntry {
  /**
   * Tool namespace for this server; the model sees `mcp__<name>__<tool>`.
   * Also the identity a reconcile matches on, so renaming replaces the server.
   */
  name: string
  /** Executable to spawn. */
  command: string
  /** Arguments passed to the command. */
  args: readonly string[]
  /** Whether to mount it; a disabled entry is kept but not run. */
  enabled: boolean
}

/** Managed server configuration. */
export interface Config {
  /** Servers this installation manages, in the order they were added. */
  servers: readonly McpServerEntry[]
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  servers: z.array(z.object({
    name: z.string().required(),
    command: z.string().required(),
    args: z.array(String).default([]),
    enabled: z.boolean().default(true),
  })).default([]),
}) as unknown as z<Config>

/** What a mounted entry was mounted from, so an unchanged one is left running. */
function mountKey(entry: McpServerEntry): string {
  return JSON.stringify([entry.command, entry.args])
}

/**
 * Mount and unmount `mcp-client` instances to match the settings list.
 * @param ctx - the context the managed instances are mounted on.
 * @param config - the composition's own default list.
 */
export function apply(ctx: Context, config: Config): void {
  /** The authoritative list: the settings section, or the composition entry. */
  let source: () => Config = () => config
  /** Server name to the fiber serving it and the shape it was mounted from. */
  const mounted = new Map<string, { key: string; fiber: Fiber }>()
  /** Serializes reconciles: two overlapping passes would both see one stale map. */
  let pending = Promise.resolve()
  let disposedFlag = false
  /**
   * Read through a call: the checker carries the first check's narrowing across
   * the `await` in between and would call the second one dead.
   */
  const stopped = (): boolean => disposedFlag

  async function reconcile(): Promise<void> {
    /* v8 ignore next -- a pass queued before disposal and entered after it; the
       window is inside the scheduler, with nothing a test can observe between. */
    if (stopped()) return
    const desired = new Map(
      source().servers.filter(entry => entry.enabled).map(entry => [entry.name, entry]),
    )
    // Unmount first, and let each unmount finish. The name is released as the
    // fiber disposes, so a replacement would not be refused either way — what
    // the await buys is that the old child process is gone before its
    // replacement spawns. An MCP server may hold something exclusive (a port, a
    // lock, a device), and two generations of one server overlapping is a
    // conflict this manager would have caused.
    for (const [serverName, record] of [...mounted]) {
      const entry = desired.get(serverName)
      if (entry !== undefined && mountKey(entry) === record.key) continue
      mounted.delete(serverName)
      await record.fiber.dispose()
    }
    if (stopped()) return
    for (const [serverName, entry] of desired) {
      if (mounted.has(serverName)) continue
      // One bad entry must cost only itself. Schemastery validates as it
      // constructs and mcp-client reserves its namespace during activation, so
      // a refusal arrives synchronously here — and left uncaught it would
      // abandon the rest of this pass, letting one mistyped name silently take
      // down every server after it in the list.
      let fiber: Fiber
      try {
        // Through the schema rather than as an object literal: mcp-client's own
        // defaults (timeouts, the reconnect policy) are Schemastery's to fill,
        // and a managed server must behave exactly like a composed one. The
        // assertion is the one every Schemastery caller makes — the type
        // describes the filled value, not what construction accepts.
        fiber = ctx.plugin(McpClient, McpClient.Config({
          transport: 'stdio',
          serverName,
          command: entry.command,
          args: [...entry.args],
        } as McpClient.Config))
      } catch (error: unknown) {
        ctx.logger.error(`mcp-servers: server "${serverName}" was refused: %o`, error)
        continue
      }
      mounted.set(serverName, { key: mountKey(entry), fiber })
      // The asynchronous half of the same rule: mcp-client keeps retrying its
      // own connection, so what lands here is a mount that was refused after
      // activation began.
      void fiber.await().catch((error: unknown) => {
        ctx.logger.error(`mcp-servers: server "${serverName}" failed to mount: %o`, error)
        /* v8 ignore next -- guards the case where a later pass already replaced
           this slot, so the rejection must not evict its successor. */
        if (mounted.get(serverName)?.fiber === fiber) mounted.delete(serverName)
      })
    }
  }

  const schedule = (): void => {
    pending = pending.then(reconcile, reconcile)
  }

  installSettingsSection(ctx, MCP_SERVERS_NAMESPACE, Config, config, {
    setSource: (current) => { source = current },
    onChange: schedule,
  })
  // Also reconcile without waiting to be told to. `installSettingsSection`
  // announces through a settings injection, so a deployment that composes
  // servers but mounts no settings provider would otherwise never receive a
  // first pass and would run none of them. A second pass costs nothing:
  // reconciling is idempotent, and an entry already mounted is left alone.
  schedule()

  ctx.effect(() => () => {
    disposedFlag = true
    const running = [...mounted.values()]
    mounted.clear()
    for (const record of running) void record.fiber.dispose()
  }, 'mcp-servers: unmount managed servers')
}
