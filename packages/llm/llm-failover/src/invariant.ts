/** Package-owned durable failover-event invariants. @module @deepseek-ai/dsh-llm-failover/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-failover'

/** Cordis companion plugin name. */
export const name = 'llm-failover-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the provider-neutral failure carried on the durable record. */
function validateFailure(value: unknown, fail: InvariantFailure): asserts value is LlmFailure {
  if (typeof value !== 'object' || value === null) {
    fail('llm/failover failure must be an object')
  }
  const failure = value as Partial<LlmFailure>
  if (typeof failure.message !== 'string' || failure.message.length === 0) {
    fail('llm/failover failure.message must be a non-empty string')
  }
  if (typeof failure.code !== 'string' || failure.code.length === 0) {
    fail('llm/failover failure.code must be a non-empty string')
  }
}

/** Validate one reroute record against the currently open request step. */
function validateFailover(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/failover'>,
  fail: InvariantFailure,
): void {
  const { turn, step, from, to, model, cooldownMs } = event.data
  validateFailure(event.data.failure, fail)
  for (const [label, value] of [['from', from], ['to', to], ['model', model]] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      fail(`llm/failover ${label} must be a non-empty string`)
    }
  }
  // A reroute to the route that just failed is not a reroute; recording one
  // would describe a retry this plugin never asked for.
  if (from === to) fail(`llm/failover rerouted ${from} to itself`)
  // Finiteness is not re-checked: a non-finite number cannot survive the
  // session log's own serialization, so it never reaches this validator.
  if (cooldownMs <= 0) fail('llm/failover cooldownMs must be a positive number')

  const turnBoundary = history.findLast(prior =>
    prior.type === 'turn/start' || prior.type === 'turn/end')
  if (turnBoundary?.type !== 'turn/start') {
    fail('llm/failover must be appended inside an open turn')
  }
  if (turn !== turnBoundary.data.turn) {
    fail(`llm/failover names turn ${turn}, but the open turn is ${turnBoundary.data.turn}`)
  }

  const stepBoundary = history.findLast(prior =>
    prior.type === 'step/start' || prior.type === 'step/end')
  if (stepBoundary?.type !== 'step/start') {
    fail('llm/failover must be appended inside an open step')
  }
  if (step !== stepBoundary.data.step || turn !== stepBoundary.data.turn) {
    fail(`llm/failover names turn ${turn}/step ${step}, but the open step is ${stepBoundary.data.turn}/${stepBoundary.data.step}`)
  }
}

/** Validate every reroute record already present in one loaded session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    if (event.type === 'llm/failover') validateFailover(session.events.slice(0, index), event, fail)
  }
}

/** Install validation for loaded and newly appended reroute records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'llm/failover') validateFailover(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the LLM failover invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
