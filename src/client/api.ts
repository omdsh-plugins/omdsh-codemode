/**
 * The one call this surface makes to its own host half: the terminal socket's
 * URL, with the conversation, the Code session, and the browser's view of the
 * directory on it.
 *
 * `cwd` rides the query as a fallback for a conversation the host has
 * attached, and as the ANSWER for a Code session it has not: a session being
 * resumed is cold in the web host — the terminal that owns it is another
 * process — so the directory the sidebar grouped it under is the only place
 * left to read it from.
 *
 * `code` is what makes a Code conversation addressable. Absent, the host mints
 * a new Code session and says which one it minted; present, it resumes exactly
 * that one — unless `fresh` says the surface minted it a moment ago, which is
 * how New Session asks for another conversation in a directory that already
 * has one.
 *
 * `resume` is the offer under it: what to continue if the host has nothing
 * running here. It is what makes pressing Code after a restart come back to
 * the project's most recent conversation instead of an empty prompt, and it
 * loses to a live terminal precisely because the browser cannot see one.
 * @module @omdsh-plugins/omdsh-code/src/client/api
 */

import { TERMINAL_PATH } from '../shared.ts'

/** Which conversation the surface is showing, and where it believes it runs. */
export interface Scope {
  /** The conversation id (the web session the column belongs to). */
  sessionId: string
  /** Its directory as the session and workspace lists have it, when they do. */
  cwd: string | undefined
  /**
   * The Code session to resume, when the surface is showing one it already
   * knows about; absent asks the host for a new conversation.
   */
  codeSessionId?: string | undefined
  /**
   * Whether {@link Scope.codeSessionId} is a conversation this surface just
   * minted rather than one it is resuming.
   *
   * The two are the same request on the wire and different facts about the
   * world: a resume may be refused, because another process can be holding
   * that session, while a minted id cannot be held by anyone. The host uses it
   * for exactly one decision — whether this terminal may later answer as "the
   * terminal for this project" — and a conversation the user just started in
   * this directory is precisely that.
   */
  fresh?: boolean | undefined
  /**
   * The conversation to continue if the host has no terminal running in this
   * directory — the project's most recent Code conversation.
   *
   * An OFFER rather than an instruction, and the difference is the whole
   * reason it is a second field: the host's own live terminal outranks it,
   * because a conversation started a moment ago has nothing on disk to be
   * "most recent" and reviving an older one over a running agent would strand
   * it. What this expresses is only what pressing Code should mean on a host
   * that has just started — come back to the work, not to an empty prompt.
   */
  resumeSessionId?: string | undefined
}

/**
 * Build the terminal socket URL for one scope and grid size.
 * @param scope - the conversation.
 * @param cols - the surface's width in cells.
 * @param rows - its height in cells.
 * @returns the same-origin `ws:`/`wss:` URL.
 */
export function terminalUrl(scope: Scope, cols: number, rows: number): string {
  const url = new URL(TERMINAL_PATH, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('session', scope.sessionId)
  if (scope.codeSessionId !== undefined && scope.codeSessionId !== '') {
    url.searchParams.set('code', scope.codeSessionId)
    if (scope.fresh === true) url.searchParams.set('fresh', '1')
  } else if (scope.resumeSessionId !== undefined && scope.resumeSessionId !== '') {
    // Only when nothing is named: an offer is what to do INSTEAD of starting
    // a new conversation, never instead of the one being asked for.
    url.searchParams.set('resume', scope.resumeSessionId)
  }
  if (scope.cwd !== undefined && scope.cwd !== '') url.searchParams.set('cwd', scope.cwd)
  url.searchParams.set('cols', String(cols))
  url.searchParams.set('rows', String(rows))
  return url.toString()
}
