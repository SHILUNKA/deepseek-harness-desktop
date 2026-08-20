import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable record of one request rerouted from an unusable provider to the next configured one. */
    'llm/failover': LlmFailoverEventData
  }
}

/** Durable payload recorded when a failed request is rerouted to another provider. */
export interface LlmFailoverEventData {
  /** Turn the failed request belonged to. */
  turn: number
  /** Step within that turn. */
  step: number
  /** Route that failed and is now cooling down. */
  from: string
  /** Route serving the retry. */
  to: string
  /** Model the serving route is called with. */
  model: string
  /** How long `from` is skipped, in milliseconds. */
  cooldownMs: number
  /** The provider-neutral failure that triggered the reroute. */
  failure: LlmFailure
}
