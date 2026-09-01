import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as McpServers from '../src/index.ts'

const FIXTURE = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function entry(name: string, enabled = true): McpServers.McpServerEntry {
  return { name, command: process.execPath, args: [FIXTURE], enabled }
}

/** A managed server connects out of process, so its tools appear asynchronously. */
async function waitForTool(ctx: Context, publicName: string, present: boolean): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((ctx.tools.get(publicName) !== undefined) === present) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${publicName} to be ${present ? 'present' : 'gone'}`)
}

let context: Context | undefined

async function boot(config: McpServers.Config = { servers: [] }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemorySettings).await()
  await ctx.plugin((inner: Context) => {
    McpServers.apply(inner, config)
  }).await()
  context = ctx
  return ctx
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('settings-managed MCP servers', () => {
  it('mounts a server the settings list gains, without a restart', async () => {
    const ctx = await boot()
    expect(ctx.tools.get('mcp__added__echo')).toBeUndefined()

    await ctx.settings.update(McpServers.MCP_SERVERS_NAMESPACE, { servers: [entry('added')] })

    // The whole point: a settings write, not a file edit, is what gains a server.
    await waitForTool(ctx, 'mcp__added__echo', true)
  }, 30_000)

  it('unmounts a server the settings list loses', async () => {
    const ctx = await boot({ servers: [entry('temporary')] })
    await waitForTool(ctx, 'mcp__temporary__echo', true)

    await ctx.settings.update(McpServers.MCP_SERVERS_NAMESPACE, { servers: [] })

    await waitForTool(ctx, 'mcp__temporary__echo', false)
  }, 30_000)

  it('keeps a disabled entry without running it', async () => {
    // Disabled is not deleted: the entry survives so a person can turn it back
    // on without retyping the command it took them a search to find.
    const ctx = await boot({ servers: [entry('parked', false)] })

    await new Promise(resolve => setTimeout(resolve, 200))

    expect(ctx.tools.get('mcp__parked__echo')).toBeUndefined()
  }, 30_000)

  it('replaces a server whose command changed', async () => {
    const ctx = await boot({ servers: [entry('swapped')] })
    await waitForTool(ctx, 'mcp__swapped__echo', true)

    // Same name, different command: the old instance must release the name
    // before the new one claims it, or mcp-client refuses the duplicate and the
    // server is simply gone. The fixture names its tool after the argument, so
    // the new generation is only observable if it actually mounted.
    await ctx.settings.update(McpServers.MCP_SERVERS_NAMESPACE, {
      servers: [{ name: 'swapped', command: process.execPath, args: [FIXTURE, '--again'], enabled: true }],
    })

    await waitForTool(ctx, 'mcp__swapped__echo2', true)
    await waitForTool(ctx, 'mcp__swapped__echo', false)
  }, 30_000)

  it('leaves the other servers running when one entry changes', async () => {
    const ctx = await boot({ servers: [entry('kept'), entry('edited')] })
    await waitForTool(ctx, 'mcp__kept__echo', true)
    await waitForTool(ctx, 'mcp__edited__echo', true)

    await ctx.settings.update(McpServers.MCP_SERVERS_NAMESPACE, {
      servers: [
        entry('kept'),
        { name: 'edited', command: process.execPath, args: [FIXTURE, '--again'], enabled: true },
      ],
    })
    await waitForTool(ctx, 'mcp__edited__echo2', true)

    // Editing one server must not restart the others: an unchanged entry keeps
    // the instance it already had, so its tools never leave the registry.
    expect(ctx.tools.get('mcp__kept__echo')).toBeDefined()
  }, 30_000)

  it('reports a server it cannot mount without taking the others down', async () => {
    // A name mcp-client refuses: the tool namespace it would publish is not one
    // the model-facing naming contract accepts.
    const ctx = await boot({
      servers: [
        { name: 'bad name', command: process.execPath, args: [FIXTURE], enabled: true },
        entry('healthy'),
      ],
    })

    await waitForTool(ctx, 'mcp__healthy__echo', true)
  }, 30_000)

  it('runs the composed list when no settings provider is present', async () => {
    // A deployment may ship servers and no settings surface at all; the
    // composition entry has to stand on its own then.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin((inner: Context) => {
      McpServers.apply(inner, { servers: [entry('composed')] })
    }).await()
    context = ctx

    await waitForTool(ctx, 'mcp__composed__echo', true)
  }, 30_000)

  it('drops a server whose namespace a composed instance already holds', async () => {
    const ctx = await boot()
    // A composed row owns this namespace; mcp-client refuses the second claim
    // during activation, which is the asynchronous half of a refused mount.
    await ctx.plugin(McpClient, McpClient.Config({
      transport: 'stdio',
      serverName: 'taken',
      command: process.execPath,
      args: [FIXTURE],
    })).await()
    await waitForTool(ctx, 'mcp__taken__echo', true)

    await ctx.settings.update(McpServers.MCP_SERVERS_NAMESPACE, {
      servers: [entry('taken'), entry('fine')],
    })

    // The healthy one still arrives, and the composed instance keeps its tools.
    await waitForTool(ctx, 'mcp__fine__echo', true)
    expect(ctx.tools.get('mcp__taken__echo')).toBeDefined()
  }, 30_000)
})
