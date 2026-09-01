import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { LlmFailoverEventData } from '@deepseek-ai/dsh-llm-failover/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as failover from '../src/index.ts'

it('keeps the exported payload identical to the session event', () => {
  expectTypeOf<LlmFailoverEventData>().toEqualTypeOf<SessionEventMap['llm/failover']>()
})

type ScriptEntry = Error | StreamChunk[]

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private policy: ResolvedRetryPolicy | undefined

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  /** Give every route the same policy; the composed case needs one to spend. */
  useRetryPolicy(maxRetries: number): void {
    this.policy = resolveRetryPolicy({
      mode: 'normal',
      maxRetries,
      retryableCodes: ['RATE_LIMIT'],
      backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0 },
    }, 'failover test policy')
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.policy
  }

  /** Accept one effort, so a request carrying it survives `prepareCall`. */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('failover test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const ORDER = [
  { provider: 'mock', model: 'mock-model' },
  { provider: 'other', model: 'other-model' },
] as const

function config(overrides: Partial<failover.Config> = {}): failover.Config {
  return {
    order: ORDER,
    cooldownMs: 5 * 60 * 1000,
    quotaCooldownMs: 60 * 60 * 1000,
    ...overrides,
  }
}

let clock = 1_000_000
let context: Context | undefined

async function harness(
  adapter: ScriptedAdapter,
  failoverConfig: failover.Config = config(),
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Object.assign((inner: Context) => {
    failover.apply(inner, failoverConfig, { now: () => clock })
  }, { inject: failover.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock', 'other', 'third'], adapter)
  return ctx
}

async function run(ctx: Context, session: string, provider = 'mock'): Promise<void> {
  const agent = ctx.agentLoop.create(SessionId(session), { provider, model: 'mock-model' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

afterEach(async () => {
  clock = 1_000_000
  await context?.fiber.dispose()
  context = undefined
})

describe('cross-provider failover', () => {
  it('serves the retry from the next route when a quota is exhausted', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE),
      textResponse('served by the second account'),
    ])
    context = await harness(adapter)

    await run(context, 'quota-failover')

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.provider).toBe('mock')
    // The point of the whole plugin: the second attempt is a different account.
    expect(adapter.requests[1]?.provider).toBe('other')
    expect(adapter.requests[1]?.model).toBe('other-model')
  })

  it('records what it rerouted and for how long', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE),
      textResponse('ok'),
    ])
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('failover-record'), {
      provider: 'mock',
      model: 'mock-model',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events.filter(event => event.type === 'llm/failover')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toEqual({
      turn: 1,
      step: 1,
      from: 'mock',
      to: 'other',
      model: 'other-model',
      // A quota does not refill in minutes, so it takes the longer cooldown.
      cooldownMs: 60 * 60 * 1000,
      failure: { message: 'balance exhausted', code: QUOTA_EXCEEDED_CODE },
    })
  })

  it('skips a route this installation never got a key for', async () => {
    // What lets a deployment ship an order naming more providers than any one
    // person signs up for: the unconfigured ones fall through silently.
    const adapter = new ScriptedAdapter([
      new LlmError('no key configured', 'MISSING_CREDENTIAL'),
      textResponse('served by the configured account'),
    ])
    context = await harness(adapter)

    await run(context, 'missing-credential')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other'])
  })

  it('leaves a rejected credential to fail, so the misconfiguration surfaces', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    context = await harness(adapter)

    await expect(run(context, 'auth-terminal')).resolves.toBeUndefined()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.provider).toBe('mock')
  })

  it('leaves a route the order does not carry alone', async () => {
    const adapter = new ScriptedAdapter([new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE)])
    context = await harness(adapter)

    await run(context, 'unordered-route', 'third')

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.provider).toBe('third')
  })

  it('stops when every route is cooling rather than retrying a known-bad one', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE),
      new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE),
    ])
    context = await harness(adapter)

    await run(context, 'all-cooling')

    // mock -> other, then other is exhausted too and nothing is left.
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other'])
  })

  it('returns to the first route once its cooldown expires', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE),
      textResponse('from the second'),
      textResponse('from the first again'),
    ])
    context = await harness(adapter)

    await run(context, 'cooldown-a')
    expect(adapter.requests[1]?.provider).toBe('other')

    clock += 60 * 60 * 1000 + 1
    await run(context, 'cooldown-b')

    // The preferred route is preferred again; a cooldown is not a demotion.
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[2]?.provider).toBe('mock')
  })

  it('does not carry a reasoning effort onto the route that takes over', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE),
      textResponse('ok'),
    ])
    context = await harness(adapter)
    context.on('agent/request', async (_payload, next) => ({
      ...await next(),
      reasoningEffort: ReasoningEffortId('high'),
    }))

    await run(context, 'effort-dropped')

    expect(adapter.requests[0]?.reasoningEffort).toBe(ReasoningEffortId('high'))
    // The levels a provider accepts are its own; carrying one over can be rejected outright.
    expect(adapter.requests[1]?.reasoningEffort).toBeUndefined()
  })
})

describe('composed under same-provider retry', () => {
  it('changes provider only after retry has spent its budget on the failing one', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT'),
      new LlmError('busy', 'RATE_LIMIT'),
      new LlmError('busy', 'RATE_LIMIT'),
      textResponse('served by the second account'),
    ])
    adapter.useRetryPolicy(2)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    // Retry mounts first, so it owns the outer half of the recovery waterfall
    // and failover sees only what retry declines. That ordering IS the design.
    await ctx.plugin(Object.assign((inner: Context) => {
      retry.apply(inner, {}, { random: () => 0.5 })
    }, { inject: retry.inject }))
    await ctx.plugin(Object.assign((inner: Context) => {
      failover.apply(inner, config(), { now: () => clock })
    }, { inject: failover.inject }))
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock', 'other', 'third'], adapter)
    context = ctx

    const agent = ctx.agentLoop.create(SessionId('retry-then-failover'), {
      provider: 'mock',
      model: 'mock-model',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const idle = agent.whenIdle()
    await vi.advanceTimersByTimeAsync(60_000)
    await idle

    expect(adapter.requests.map(request => request.provider))
      .toEqual(['mock', 'mock', 'mock', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/failover')).toHaveLength(1)
    vi.useRealTimers()
  })
})

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

describe('the order as a user setting', () => {
  it('follows an order the settings document supplies', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE),
      textResponse('served by the settings choice'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemorySettings).await()
    // Composed with no order at all: everything below comes from settings.
    await ctx.plugin(Object.assign((inner: Context) => {
      failover.apply(inner, config({ order: [] }), { now: () => clock })
    }, { inject: failover.inject })).await()
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock', 'other', 'third'], adapter)
    context = ctx

    await ctx.settings.update(failover.FAILOVER_SETTINGS_NAMESPACE, {
      order: [{ provider: 'mock', model: 'mock-model' }, { provider: 'third', model: 'third-model' }],
    })
    await run(ctx, 'settings-order')

    // The settings list, not the composed one, decided who took over.
    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'third'])
  })

  it('leaves a cooling request alone when no route is left to serve it', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE),
      new LlmError('balance exhausted', QUOTA_EXCEEDED_CODE),
      textResponse('later'),
    ])
    context = await harness(adapter)
    await run(context, 'exhaust-all')
    expect(adapter.requests).toHaveLength(2)

    // Both routes are now cooling. A fresh turn must still be attempted on what
    // the person chose rather than silently rewritten to another cooling route.
    await run(context, 'after-exhaustion')

    expect(adapter.requests[2]?.provider).toBe('mock')
  })

  it('reads the wall clock when no timing hook is supplied', async () => {
    const adapter = new ScriptedAdapter([textResponse('ok')])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(Object.assign((inner: Context) => {
      failover.apply(inner, config())
    }, { inject: failover.inject })).await()
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock', 'other', 'third'], adapter)
    context = ctx

    await run(ctx, 'real-clock')

    expect(adapter.requests).toHaveLength(1)
  })
})
