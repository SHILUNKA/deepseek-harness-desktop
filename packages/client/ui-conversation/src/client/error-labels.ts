/** Product copy for the wire errors the conversation input flow surfaces. */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from './locales.ts'

/**
 * Product copy for a rejected prompt submission.
 *
 * A wire error carries a `message` written for whoever reads the server log:
 * English, phrased in the domain's own vocabulary, and silent about what the
 * person should do. The `code` is the stable part, so the copy keys on it and
 * the message is dropped.
 *
 * The split follows the one attachment rejections already use: a cause the
 * person can act on names the way out, while a cause they cannot act on folds
 * into one line that still carries the code for a bug report. An unrecognized
 * code takes that same fallback rather than showing the raw English.
 * @param t - the conversation-namespace translate.
 * @param code - the wire error code.
 * @returns the banner text.
 */
export function promptErrorText(t: Translate<ConversationKey>, code: string): string {
  switch (code) {
    case 'session/agent-busy': return t('promptError.agentBusy')
    case 'session/not-found': return t('promptError.sessionMissing')
    case 'session/conflict': return t('promptError.conflict')
    case 'gateway/cancelled': return t('promptError.cancelled')
    case 'gateway/invocation-unavailable': return t('promptError.backendUnavailable')
    case 'gateway/internal': return t('promptError.internal', { code })
    default: return t('promptError.unknown', { code })
  }
}
