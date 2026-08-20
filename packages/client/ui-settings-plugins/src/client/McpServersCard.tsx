/** The MCP card: which MCP servers this installation runs. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { LinesField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { McpServersCardFace } from './mcp-servers-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the MCP card. */
export type McpServersCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<McpServersCardFace>

/**
 * Render the MCP card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function McpServersCard(props: McpServersCardProps) {
  const { t } = props
  const state = props.useMcpServersCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="mcpTitle"
      descriptionKey="mcpDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <LinesField
        id="plugin-config-mcp-servers"
        label={t('mcpServers')}
        hint={t('mcpServersHint')}
        placeholder={'filesystem: npx -y @modelcontextprotocol/server-filesystem ~/Documents'}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('mcpServersInvalid')}
        disabled={!state.writable}
        {...state.servers}
        onEdit={(text) => { props.edit('servers', text) }}
        onReset={() => { props.resetField('servers') }}
      />
    </PluginCard>
  )
}
