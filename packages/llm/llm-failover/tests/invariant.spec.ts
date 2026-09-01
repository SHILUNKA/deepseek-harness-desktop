import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as FailoverInvariant from '@deepseek-ai/dsh-llm-failover/invariant'
import type { LlmFailoverEventData } from '../src/types.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(FailoverInvariant)
  return ctx
}

function openStep(ctx: Context, id: string, turn = 1, step = 1): Session {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  return session
}

const valid: LlmFailoverEventData = {
  turn: 1,
  step: 1,
  from: 'mock',
  to: 'other',
  model: 'other-model',
  cooldownMs: 60_000,
  failure: { message: 'balance exhausted', code: 'QUOTA' },
}

describe('llm-failover invariants', () => {
  it('accepts a complete record inside its open step', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'failover-valid')

    expect(() => { session.append('llm/failover', valid) }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it.each([
    ['a non-object failure', { ...valid, failure: null }, /failure must be an object/],
    ['an empty failure message', { ...valid, failure: { message: '', code: 'QUOTA' } }, /failure\.message/],
    ['a missing failure code', { ...valid, failure: { message: 'x', code: '' } }, /failure\.code/],
    ['an empty source route', { ...valid, from: '' }, /from must be a non-empty string/],
    ['an empty target route', { ...valid, to: '' }, /to must be a non-empty string/],
    ['an empty model', { ...valid, model: '' }, /model must be a non-empty string/],
    ['a reroute to itself', { ...valid, to: 'mock' }, /rerouted mock to itself/],
    ['a zero cooldown', { ...valid, cooldownMs: 0 }, /cooldownMs must be a positive/],
    ['a negative cooldown', { ...valid, cooldownMs: -1 }, /cooldownMs must be a positive/],
    ['a turn that is not the open one', { ...valid, turn: 2 }, /names turn 2/],
    ['a step that is not the open one', { ...valid, step: 2 }, /step 2/],
  ])('refuses %s', async (_label, data, message) => {
    const ctx = await setup()
    const session = openStep(ctx, `failover-refuses-${_label.replace(/\W+/g, '-')}`)

    expect(() => { session.append('llm/failover', data as LlmFailoverEventData) }).toThrow(message)
    await ctx.fiber.dispose()
  })

  it('refuses a record outside any open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('failover-no-turn'))

    expect(() => { session.append('llm/failover', valid) }).toThrow(/inside an open turn/)
    await ctx.fiber.dispose()
  })

  it('refuses a record outside any open step', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('failover-no-step'))
    session.append('turn/start', { turn: 1 })

    expect(() => { session.append('llm/failover', valid) }).toThrow(/inside an open step/)
    await ctx.fiber.dispose()
  })

  it('validates records already present in a session it did not watch', async () => {
    // A session loaded from disk carries records this process never appended;
    // the companion must judge those too, or a corrupt log would load clean.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = openStep(ctx, 'failover-preloaded')
    session.append('llm/failover', valid)
    await ctx.plugin(InvariantRegistry)

    await expect(ctx.plugin(FailoverInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
