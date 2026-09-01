---
description: "The cross-provider failover executor for users and maintainers configuring which provider takes over when the one in use cannot serve a request."
kind: "package-reference"
---

# `@deepseek-ai/dsh-llm-failover`

English | [中文](README.zh.md)

## Summary

Cross-provider failover on the agent loop's `agent/request-error` recovery waterfall. A provider whose quota is exhausted cannot serve the next attempt either, so repeating it is not recovery; this plugin routes the retry to the next configured provider and puts the exhausted one on a cooldown. That is what lets one person spread work across several accounts' free tiers without watching for the moment one runs dry.

## Table of Contents

- [Composition](#composition)
- [Config](#config)
- [What it reroutes](#what-it-reroutes)
- [Durable record](#durable-record)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="composition"></a>
## Composition

It composes **below** [`dsh-llm-retry`](../llm-retry/README.md) rather than replacing it. Retry owns "the same provider, a moment later" and declines what it cannot fix; whatever it declines arrives here. The split falls out of the failure taxonomy rather than any coordination between the two:

| Failure | Retry | Failover |
|---|---|---|
| `QUOTA` | outside its default retryable set, declines immediately | reroutes at once |
| `RATE_LIMIT` | spends its backoff budget on the same route | reroutes once that budget is gone |
| `MISSING_CREDENTIAL` | declines | reroutes — this installation simply lacks that route |
| `AUTH`, `INVALID_CREDENTIAL` | declines | declines — the request fails |

Mount retry first so it owns the outer half of the waterfall. Mounting failover alone is valid and simply reroutes on the first eligible failure.

<a id="config"></a>
## Config

| Field | Required | Description |
|---|---|---|
| `order` | no | Provider/model pairs tried in order; an entry cooling down is skipped. Empty (the default) disables every reroute. |
| `cooldownMs` | no | How long a route is skipped after a non-quota failure (default 300000) |
| `quotaCooldownMs` | no | How long a route is skipped after `QUOTA` (default 3600000) |

```yaml
- name: '@deepseek-ai/dsh-llm-failover'
  config:
    order:
      - provider: deepseek
        model: deepseek-chat
      - provider: qwen-token-plan-cn
        model: qwen-plus
```

Each entry carries its own model because a model id belongs to the provider that serves it; there is no id both routes would recognize.

The same fields are a **settings section** under the `llm-failover` namespace, so the composition entry above is the deployment default and a person edits the live order from Settings without touching a file. A cooldown already in effect survives an edit: reordering the list does not refill an exhausted quota.

<a id="what-it-reroutes"></a>
## What it reroutes

Only the classes another provider can plausibly serve: `QUOTA`, `MISSING_CREDENTIAL`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`. Most describe one provider's availability at one moment, which is exactly what a different provider does not share.

The two credential classes are split, because their fixes differ. `MISSING_CREDENTIAL` means no key was ever supplied — that route is not one this installation has, and skipping it is what lets a deployment ship an order naming more providers than any one person signs up for. A *rejected* key (`AUTH`, `INVALID_CREDENTIAL`) is a configuration mistake with a fix, and quietly serving the request from another account would hide it for as long as any other route still works — the person would never learn that the provider they chose is misconfigured.

A route the `order` does not carry is left alone: it was chosen deliberately, and rerouting it would override that choice without being asked. When every route is cooling, the failure stays terminal rather than being retried against a provider already known to be bad.

A cooldown is not a demotion. Once it expires the preferred route is preferred again, which is what makes a daily free allowance work: the allowance runs out, the day's remaining work moves on, and tomorrow's first request is back on the first choice. Cooldowns live in memory, so a restart returns to the first route and learns again at the cost of one failed attempt.

<a id="durable-record"></a>
## Durable record

Each reroute appends `llm/failover` to the session: the route that failed, the one taking over, its model, the cooldown, and the provider-neutral failure. Without it a provider switch is invisible, and a person who never learns that their first choice ran dry cannot act on it. The [invariant companion](src/invariant.ts) validates every record at the durable boundary.

<a id="model-experience"></a>
## Model Experience

### Rerouted model request

#### What the model sees

Nothing of the reroute: the retried request carries the same messages, system prompt, and tools. The model serving it is a different one, so the reply reflects the second provider's model rather than the first.

Reasoning effort is dropped when a route takes over. The levels a provider accepts are its own, and carrying one across can be rejected outright by a model that never offered it.

#### Token effect

None directly; the rerouted request is the same request. The serving model's own tokenizer and context accounting apply.

#### KV Cache effect

A reroute forfeits the prefix cache. The second provider has never seen this conversation, so its first request is a full cache miss regardless of how stable the prefix was on the first. Subsequent steps warm normally on the new provider until a cooldown expires and the preferred route returns — which forfeits it once more.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Cooldowns are process-local** — nothing is persisted, so a restart retries an exhausted provider once before learning again, and two hosts sharing one account do not share what either learned.
- **No proactive quota accounting** — a route is only ever learned to be exhausted by failing. The plugin cannot know a free tier is nearly spent before the provider says so.
- **The order is static** — entries are tried in the order given, with no health-based reordering or weighting, and no per-model fallthrough within one provider.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The base bundle mounts this row after `llm-retry`, which is what puts it inside retry on the recovery waterfall. The division of labour falls out of the failure taxonomy alone and needs no coordination: `QUOTA` is absent from retry's default retryable set and passes straight through, while `RATE_LIMIT` is in it, so retry spends its backoff budget first. The integration test pins that sequence as `['mock','mock','mock','other']`.
- The other half claims the outermost position on `agent/request` with `prepend: true`, overriding the agent-scoped model selection (a cordis waterfall runs outermost-first). A retry re-enters `agent/request` but does *not* re-enter `system-prompt/assemble`, so mutating `selection.current` alone has no effect.
- `MISSING_CREDENTIAL` switches while `AUTH` and `INVALID_CREDENTIAL` do not: a key that was never supplied is another route's turn, but a misconfigured one must surface. That split is what lets a deployment ship an order longer than any one person has registered for.

</details>
