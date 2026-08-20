/**
 * Cross-provider failover on the agent loop's request-recovery waterfall.
 *
 * A provider that has run out of quota cannot serve the next attempt either, so
 * repeating it is not recovery. This plugin routes the retry to the next
 * configured provider instead and puts the exhausted one on a cooldown, which
 * is what lets a person spread work across several accounts' free tiers without
 * watching for the moment one runs dry.
 *
 * It composes below `dsh-llm-retry` rather than replacing it: retry owns "the
 * same provider, a moment later" and declines what it cannot fix, and whatever
 * it declines arrives here. `QUOTA` is outside retry's default retryable set,
 * so it reaches this plugin immediately; `RATE_LIMIT` reaches it only after
 * retry has spent its backoff budget on the same route.
 *
 * @module @deepseek-ai/dsh-llm-failover
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { QUOTA_EXCEEDED_CODE, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { LlmFailoverEventData } from './types.ts'

export type { LlmFailoverEventData } from './types.ts'

export const name = 'llm-failover'
export const inject = ['agents']

/**
 * Namespace the fallthrough order is edited under. The order is a user setting
 * rather than composition: which accounts a person holds, and which they would
 * rather spend first, is theirs to change without editing a YAML file.
 */
export const FAILOVER_SETTINGS_NAMESPACE = settingsNamespace('llm-failover')

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60 * 1000

/**
 * Failure classes another provider can plausibly serve.
 *
 * Overload and transport classes are properties of one provider's availability
 * at one moment, which is exactly what another provider does not share.
 *
 * The two credential classes are split deliberately, because their fixes
 * differ. `MISSING_CREDENTIAL` means no key was ever supplied: that route is
 * simply not one this installation has, and skipping it is what lets a
 * deployment ship an order naming more providers than any one person signs up
 * for. A *rejected* key (`AUTH`, `INVALID_CREDENTIAL`) is a configuration
 * mistake with a fix, and quietly serving the request from another account
 * would hide it for as long as any other route still works — the person would
 * never learn that the provider they chose is misconfigured.
 */
const FAILOVER_CODES: ReadonlySet<string> = new Set([
  QUOTA_EXCEEDED_CODE,
  'MISSING_CREDENTIAL',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/** One provider/model pair the fallthrough order may land on. */
export interface FailoverRoute {
  /** Registered provider route id. */
  provider: string
  /** Model to call that route with; a route's models are its own. */
  model: string
}

/** Failover configuration. */
export interface Config {
  /** Routes tried in order; an entry cooling down is skipped. */
  order: readonly FailoverRoute[]
  /** How long a route is skipped after a non-quota failure. */
  cooldownMs: number
  /** How long a route is skipped after its quota is exhausted. */
  quotaCooldownMs: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  order: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })).default([]),
  cooldownMs: z.number().step(1).min(1000).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_COOLDOWN_MS),
  quotaCooldownMs: z.number().step(1).min(1000).max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_QUOTA_COOLDOWN_MS),
}) as unknown as z<Config>

/** Non-serializable hooks that make cooldown timing deterministic in tests. */
export interface FailoverInternals {
  /** Current epoch milliseconds. */
  now?: () => number
}

/**
 * Install cross-provider failover.
 * @param ctx - the context the plugin is mounted on.
 * @param config - the fallthrough order and cooldown durations.
 * @param internals - test-only timing hooks.
 */
export function apply(ctx: Context, config: Config, internals?: FailoverInternals): void {
  const now = internals?.now ?? ((): number => Date.now())
  /** Route id to the epoch millisecond it becomes usable again. */
  const cooling = new Map<string, number>()
  /** The authoritative config: the settings section, or the composition entry. */
  let source: () => Config = () => config
  installSettingsSection(ctx, FAILOVER_SETTINGS_NAMESPACE, Config, config, {
    setSource: (current) => { source = current },
    // Cooldowns key on the route id and deliberately survive an order edit: a
    // provider that just reported an exhausted quota has not refilled because
    // the person reordered the list.
    onChange: () => {},
  })

  const isCooling = (provider: string): boolean => (cooling.get(provider) ?? 0) > now()
  const nextUsable = (): FailoverRoute | undefined =>
    source().order.find(route => !isCooling(route.provider))

  async function recover(
    { agent, turn, step, provider, failure }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    if (!FAILOVER_CODES.has(failure.code)) return next()
    // A route the order does not carry was chosen deliberately and is not this
    // plugin's to reroute; rerouting it would override that choice silently.
    const active = source()
    if (!active.order.some(route => route.provider === provider)) return next()
    const cooldownMs = failure.code === QUOTA_EXCEEDED_CODE
      ? active.quotaCooldownMs
      : active.cooldownMs
    cooling.set(provider, now() + cooldownMs)
    const target = nextUsable()
    // Every route is cooling: the failure is the honest answer, so it stays
    // terminal rather than being retried against a provider already known bad.
    if (target === undefined) return next()
    const event: LlmFailoverEventData = {
      turn,
      step,
      from: provider,
      to: target.provider,
      model: target.model,
      cooldownMs,
      failure,
    }
    agent.session.append('llm/failover', event)
    return { kind: 'retry' }
  }

  ctx.on('agent/request-error', (
    payload,
    next: () => Promise<RequestErrorAction>,
  ) => recover(payload, next))

  // Outermost on the request waterfall: the retry re-enters `agent/request`,
  // where agent-scoped model selection applies the model the person picked. A
  // cooling route has to lose that contest, and only the outermost listener
  // sees — and can replace — what every other one decided.
  ctx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (!isCooling(resolved.provider)) return resolved
    const target = nextUsable()
    if (target === undefined) return resolved
    // Reasoning effort belongs to the model that was left behind: the levels a
    // provider accepts are its own, so carrying one across would offer the new
    // model a level it may reject outright.
    const { reasoningEffort: _leftBehind, ...rerouted } = resolved
    return { ...rerouted, provider: target.provider, model: target.model }
  }, true)
}
