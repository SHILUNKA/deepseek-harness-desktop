/** The failover card: which providers take over, and for how long one is skipped. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { FailoverCardFace } from './failover-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the failover card. */
export type FailoverCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<FailoverCardFace>

/**
 * Render the failover card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function FailoverCard(props: FailoverCardProps) {
  const { t } = props
  const state = props.useFailoverCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="failoverTitle"
      descriptionKey="failoverDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-failover-order"
        label={t('failoverOrder')}
        hint={t('failoverOrderHint')}
        placeholder="deepseek/deepseek-chat, qwen-token-plan-cn/qwen-plus"
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('failoverOrderInvalid')}
        disabled={!state.writable}
        {...state.order}
        onEdit={(text) => { props.edit('order', text) }}
        onReset={() => { props.resetField('order') }}
      />
      <ValueField
        id="plugin-config-failover-quota-cooldown"
        label={t('failoverQuotaCooldown')}
        hint={t('failoverQuotaCooldownHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={!state.writable}
        {...state.quotaCooldownMs}
        onEdit={(text) => { props.edit('quotaCooldownMs', text) }}
        onReset={() => { props.resetField('quotaCooldownMs') }}
      />
      <ValueField
        id="plugin-config-failover-cooldown"
        label={t('failoverCooldown')}
        hint={t('failoverCooldownHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={!state.writable}
        {...state.cooldownMs}
        onEdit={(text) => { props.edit('cooldownMs', text) }}
        onReset={() => { props.resetField('cooldownMs') }}
      />
    </PluginCard>
  )
}
