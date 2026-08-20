# Agent Note: Cross-provider failover

Status: implemented

English | [中文](2026-08-20-cross-provider-failover.zh.md)

## Problem

Several providers hand out a free daily or monthly allowance, and one allowance rarely covers a day of agent work. When it runs out the provider answers `QUOTA`, and nothing in the harness could do anything with that answer: `dsh-llm-retry` implements *exact-provider* retry, so it waits and asks the same exhausted account again, and `QUOTA` is not even in its default retryable set — the failure went straight to the user as a dead turn. A person holding keys for four providers had to notice the failure, open Settings, and switch the model by hand, several times a day.

## Decision

`@deepseek-ai/dsh-llm-failover` reroutes a failed request to the next configured provider and puts the failing one on a cooldown.

It composes **below** `dsh-llm-retry` on the `agent/request-error` waterfall — mounted after it in `packages/bundle/base/cordis.patch.yml`, which by Cordis's outermost-first ordering makes retry the outer half. No coordination between the two exists or is needed, because the failure taxonomy already separates them: `QUOTA` is outside retry's default retryable set and reaches failover immediately, while `RATE_LIMIT` reaches it only after retry has spent its backoff budget on the same route.

The other half installs on `agent/request` with `prepend: true`, taking the outermost position so it can replace what agent-scoped model selection decided. This is required rather than stylistic: a retry re-enters `agent/request` but **not** `system-prompt/assemble`, and `installModelSelection` applies `selection.assembled` — the value captured at assembly — so changing anything else would not survive into the retried request. The listener is inert unless the resolved provider is cooling, so an explicit choice is never overridden while it still works.

Credential failures are split by fix. `MISSING_CREDENTIAL` reroutes: no key was ever supplied, so that route is not one this installation has, and skipping it is what lets a deployment ship an order naming more providers than any one person signs up for. `AUTH` and `INVALID_CREDENTIAL` do not: a rejected key is a configuration mistake, and quietly serving from another account would hide it for as long as any other route works.

Reasoning effort is dropped on reroute — the levels a provider accepts are its own, and carrying one across can be rejected outright.

Each reroute appends `llm/failover` to the session, so a provider switch is visible rather than silent, and the order itself is a settings section (`llm-failover`) with a card under Settings → Plugins.

## Alternatives considered

**Wrapping `ctx.llm.stream()`.** Rejected for the same reason `dsh-llm-retry` documents: every adapter call should remain one provider attempt, with each retry opening its own numbered turn in the log. A wrapper hides the second provider's attempt inside the first one's turn.

**Switching in `api-proxy`, which already owns `ModelSelectionRef`.** That would have reached the mutable selection directly and needed no waterfall position — but it is the web/desktop entry point, so the CLI would gain nothing from a capability that is not transport-specific.

**Permanently switching rather than cooling.** A cooldown that expires is what makes a *daily* allowance work: the allowance runs out, the day's remaining work moves on, and tomorrow's first request is back on the first choice. Demotion would leave the preferred provider unused indefinitely after one bad afternoon.

**Shipping a default order.** Rejected: an order entry needs a model id, and model ids change on the provider's schedule rather than this repository's. The composed default is empty and the list is filled in from Settings.

## Consequences

A person can spend several free tiers in one day without watching for the moment one runs dry, and a switch is recorded rather than silent.

Cost: cooldowns are process-local, so a restart retries an exhausted provider once before learning again, and two hosts sharing an account do not share what either learned. A reroute forfeits the prefix cache, because the second provider has never seen the conversation. The order is static — no health-based reordering, no weighting, and no per-model fallthrough within one provider. Nothing is learned before a provider actually fails: there is no proactive quota accounting.

## Testing

`packages/llm/llm-failover/tests/failover.spec.ts` covers quota reroute, the durable record, the credential split, the unordered-route and all-cooling cases, cooldown expiry, and effort dropping. One composed case mounts retry and failover together and asserts the request sequence `['mock', 'mock', 'mock', 'other']` — the ordering claim above, verified rather than assumed.
