/**
 * What Code mode's column is handed.
 *
 * The column occupies `conversation` — ui-layout's single seat for the whole
 * centre, the one the web conversation itself normally holds. Registering
 * there replaces that surface outright, which is exactly the ask: in Code mode
 * the column IS the harness terminal. The registration is added when the mode
 * is entered and disposed when it is left, so the conversation comes back
 * untouched.
 * @module @omdsh-plugins/omdsh-code/src/client/contract
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-layout's SlotMap merge (the seat this column takes)
// into this program. A value import would be a purity error.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { Scope } from './api.ts'

/** Injected face of the column: which conversation's workspace it is showing. */
export interface CodeColumnInjected {
  /** Framework-bound sources: the live scope, or `undefined` before one exists. */
  hooks: { scope: ObservableSnapshot<Scope | undefined> }
  /**
   * The host answered which Code conversation this terminal drives. The
   * column reports it back because the answer is decided per socket, and the
   * mode needs it before anything has been said in that conversation — until
   * then no list anywhere knows the session exists.
   * @param cwd - the directory the terminal runs in.
   * @param codeSessionId - the conversation it drives.
   */
  noteAttached: (cwd: string, codeSessionId: string) => void
  /**
   * The terminal announced its window title. A conversation renamed inside a
   * terminal is a durable change made by another process, and this is the only
   * word the page gets about it — the mode answers by re-reading the session
   * list, so the sidebar row catches up.
   * @param cwd - the directory the terminal runs in.
   * @param title - the announced title, verbatim.
   */
  noteTitle: (cwd: string, title: string) => void
}

/** Full column props: the conversation seat, the injected scope, and copy. */
export type CodeColumnProps =
  PropsRuntime<'conversation'>
  & InjectFace<CodeColumnInjected>
  & PropsLocale<'omdsh-code'>
