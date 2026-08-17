/**
 * What makes a session a Code session: its id.
 *
 * Code mode has to answer "did I start this conversation?" in two places that
 * share no memory — the host, deciding whether to resume a terminal into an
 * existing session, and the browser, deciding which sidebar rows are Code rows
 * — and it has to keep answering after a restart, in another tab, and for a
 * log this process never saw. Everything that could carry that fact somewhere
 * else is worse:
 *
 * - A durable table beside the session store is a second source of truth that
 *   can disagree with the logs (a deleted log, a copied `$DSH_HOME`) and needs
 *   its own migration story.
 * - The session header records `cwd`, `agentPreset`, and `origin`, and none of
 *   them can be set to "started by Code mode" without a harness change.
 * - Guessing from the terminal's own convention (`main-session-*`) would claim
 *   every session the user ever started from a real terminal, which is not
 *   what Code mode started and not what it can account for.
 *
 * So Code mode NAMES the sessions it starts, and the name is the record. The
 * id is minted here, handed to the terminal as `--session-id`, and read back
 * out of any session list by prefix — durable because the id is durable, and
 * with nothing to keep in step.
 *
 * Node-free, like [shared](./shared.ts): the browser half imports this module
 * for real.
 * @module @omdsh-plugins/omdsh-codemode/src/code-session
 */

/**
 * Prefix every session Code mode starts carries.
 *
 * It mirrors the terminal's own `main-session-` shape (the agent id, then the
 * session) so a person reading `$DSH_HOME/sessions/` sees the same kind of
 * name — and it differs from it, which is the whole point: a session named
 * here is one this plugin started and can bring back.
 */
export const CODE_SESSION_PREFIX = 'code-session-'

/**
 * Mint an id for a terminal Code mode is about to start.
 *
 * `crypto.randomUUID` rather than a counter: the id is durable, ends up in a
 * filesystem path, and is minted by whichever process is serving the page —
 * two hosts on one `$DSH_HOME` must not be able to collide.
 * @returns a fresh Code-session id.
 */
export function mintCodeSessionId(): string {
  return `${CODE_SESSION_PREFIX}${crypto.randomUUID()}`
}

/**
 * Whether a session id names a conversation Code mode started.
 * @param sessionId - any session id.
 * @returns true for a Code session.
 */
export function isCodeSessionId(sessionId: string): boolean {
  return sessionId.startsWith(CODE_SESSION_PREFIX)
}

/**
 * Which conversation a terminal socket drives, in the order of how much is
 * actually known — the safety argument of this plugin, as one function.
 *
 * 1. **What the surface named**: a Code row the user clicked, or the terminal
 *    this page already had.
 * 2. **The host's live terminal in that directory**: what "the terminal for
 *    this project" means across a page reload, and the only fact here that a
 *    browser cannot see.
 * 3. **What the surface offered**: the project's most recent conversation,
 *    which is what pressing Code should mean on a host that just started.
 * 4. **A new one**, when this project has none.
 *
 * The offer sits BELOW the live terminal deliberately. A conversation started
 * a moment ago has nothing on disk to be "most recent", so a browser that
 * outranked the live table would revive an older conversation over a running
 * agent — and two live copies of one conversation interleave their sequence
 * numbers until the log stops loading at all.
 * @param requested - the conversation the surface named, when it named one.
 * @param live - the host's live terminal in that directory, when it has one.
 * @param offered - the conversation the surface offered to continue.
 * @returns the conversation to drive, or undefined to mint a new one.
 */
export function chooseCodeSession(
  requested: string | null,
  live: string | undefined,
  offered: string | null,
): string | undefined {
  if (requested !== null && requested !== '') return requested
  if (live !== undefined && live !== '') return live
  return offered !== null && offered !== '' ? offered : undefined
}

/**
 * Whether a socket naming a conversation is RESUMING it — reaching for a
 * conversation that existed before the request — rather than opening one the
 * surface minted a moment earlier.
 *
 * The two look identical on the wire and differ in the one way that matters:
 * a conversation that already existed may be held by another process, so a
 * terminal opened for it can fail to take its session, while a just-minted id
 * cannot be held by anyone. That is why New Session in Code mode says `fresh`:
 * its terminal is this directory's terminal from the moment it starts, and a
 * resumed one never is.
 * @param requested - the `code` query parameter, or null when absent.
 * @param fresh - whether the surface said it minted the id.
 * @returns true when this is a resume.
 */
export function isResumeRequest(requested: string | null, fresh: boolean): boolean {
  return requested !== null && requested !== '' && !fresh
}
