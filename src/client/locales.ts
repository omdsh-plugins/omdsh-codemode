/** `omdsh-codemode` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'mode.code': '编码',
  'mode.code.hint': '在这个工作区里开一个 harness 终端',
  'mode.code.unavailable': '先添加一个项目，终端才有地方可跑',
  'surface.connecting': '正在连接终端…',
  'surface.failed': '终端连不上',
  'surface.retry': '重试',
  'surface.noWorkspace': '这个会话还没有工作目录',
} satisfies Record<string, string>

/** The omdsh-codemode namespace key union. */
export type CodeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'mode.code': 'Code',
  'mode.code.hint': 'A harness terminal in this workspace',
  'mode.code.unavailable': 'Add a project first — a terminal needs somewhere to run',
  'surface.connecting': 'Connecting to the terminal…',
  'surface.failed': 'The terminal is unreachable',
  'surface.retry': 'Retry',
  'surface.noWorkspace': 'This session has no working directory yet',
} satisfies Record<CodeKey, string>
