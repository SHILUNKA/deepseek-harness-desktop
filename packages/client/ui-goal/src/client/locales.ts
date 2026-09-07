/** `goal` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'phase.active': '进行中的目标',
  'phase.paused': '已暂停的目标',
  'phase.blocked': '受阻的目标',
  'objective.aria': '目标内容',
  'commandInput.aria': '指令输入',
  'action.save': '保存目标',
  'action.cancel': '取消编辑',
  'action.pause': '暂停目标',
  'action.resume': '恢复目标',
  'action.edit': '编辑目标',
  'action.clear': '清除目标',
  'error.busy': '当前会话正在运行，请等它结束后再改目标',
  'error.conflict': '目标已在别处变动，请刷新页面后重试',
  'error.unknown': '操作失败，请重试；若反复出现请把错误码反馈给我们（{code}）',
} satisfies Record<string, string>

/** The goal namespace key union. */
export type GoalKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'phase.active': 'Ongoing Goal',
  'phase.paused': 'Paused Goal',
  'phase.blocked': 'Blocked Goal',
  'objective.aria': 'Goal objective',
  'commandInput.aria': 'Command input',
  'action.save': 'Save goal',
  'action.cancel': 'Cancel edit',
  'action.pause': 'Pause goal',
  'action.resume': 'Resume goal',
  'action.edit': 'Edit goal',
  'action.clear': 'Clear goal',
  'error.busy': 'This session is still running — wait for it to finish before changing the goal',
  'error.conflict': 'The goal changed elsewhere; reload the page and try again',
  'error.unknown': 'Action failed. Retry, and report this code if it persists ({code})',
} satisfies Record<GoalKey, string>
