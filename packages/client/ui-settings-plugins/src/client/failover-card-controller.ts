/** The failover card's staged form over the `llm-failover` settings namespace. */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, numberField,
  type CardActions, type CardFieldSpec, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the failover plugin's user-owned settings. Spelled here rather
 * than imported: a client package must not depend on a Host package.
 */
export const FAILOVER_NS = 'llm-failover'

/** One provider/model pair in the fallthrough order. */
interface FailoverRoute {
  provider: string
  model: string
}

/** The failover fields this card edits. */
export interface FailoverSettings {
  /** Routes tried in order when the one in use cannot serve a request. */
  order?: FailoverRoute[]
  /** How long a route is skipped after a non-quota failure. */
  cooldownMs?: number
  /** How long a route is skipped after its quota is exhausted. */
  quotaCooldownMs?: number
}

/**
 * The fallthrough order as one line of `provider/model` pairs.
 *
 * A route is two values, and the card framework stages text per field, so the
 * pair is spelled rather than built from two controls. The first slash splits
 * it: a provider id never contains one and a model id often does
 * (`org/name`), so everything after it belongs to the model.
 *
 * A malformed entry returns undefined, which blocks the save and marks the
 * control — dropping it silently would leave a person believing they had
 * configured a fallback that was never stored.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function routeListField(field: string): CardFieldSpec {
  const isRoute = (value: unknown): value is FailoverRoute =>
    typeof value === 'object' && value !== null
    && typeof (value as FailoverRoute).provider === 'string'
    && typeof (value as FailoverRoute).model === 'string'
  return {
    field,
    format: value => Array.isArray(value) && value.every(isRoute)
      ? value.map(route => `${route.provider}/${route.model}`).join(', ')
      : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const routes: FailoverRoute[] = []
      for (const piece of trimmed.split(',')) {
        const entry = piece.trim()
        if (entry === '') continue
        const slash = entry.indexOf('/')
        if (slash <= 0 || slash === entry.length - 1) return undefined
        routes.push({ provider: entry.slice(0, slash), model: entry.slice(slash + 1) })
      }
      return routes.length === 0 ? { kind: 'clear' } : { kind: 'set', value: routes }
    },
  }
}

/** What the failover card renders. */
export interface FailoverCardState extends CardShell {
  /** The fallthrough order. */
  order: CardFieldState
  /** Cooldown after a non-quota failure. */
  cooldownMs: CardFieldState
  /** Cooldown after an exhausted quota. */
  quotaCooldownMs: CardFieldState
}

/** The registration-side face the failover card's slot entry injects. */
export interface FailoverCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useFailoverCard. */
    failoverCard: SnapshotStore<FailoverCardState>
  }
}

/** Bridges the `llm-failover` scope onto the card's staged form. */
export class FailoverCardController {
  private readonly form: CardForm<FailoverSettings>
  private readonly store: SnapshotStore<FailoverCardState>

  /** @param scope - the bound settings scope for the `llm-failover` namespace. */
  constructor(scope: SettingsScope<FailoverSettings>) {
    this.form = new CardForm(scope, [
      routeListField('order'),
      numberField('cooldownMs'),
      numberField('quotaCooldownMs'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): FailoverCardState {
    return {
      ...this.form.shell(),
      order: this.form.field('order'),
      cooldownMs: this.form.field('cooldownMs'),
      quotaCooldownMs: this.form.field('quotaCooldownMs'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): FailoverCardFace {
    return { hooks: { failoverCard: this.store }, ...this.form.actions() }
  }
}
