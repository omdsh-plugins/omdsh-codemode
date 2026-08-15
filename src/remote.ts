/**
 * Where a Code conversation's agent actually runs.
 *
 * Code mode starts `dsh` in a workspace directory. When that directory is a
 * stand-in for one on a server, the agent belongs THERE — same conversation,
 * same session id, same working tree, a different machine — and this module is
 * the whole of what that costs: one structural view of the `remdev` service,
 * and one lookup that turns a directory into either "spawn here" or "spawn over
 * there".
 *
 * ## Why the service is described here rather than imported
 *
 * `@omdsh-plugins/omdsh-remdev` publishes a cordis service; this package does not
 * depend on it, in either direction. A composition without it resolves
 * `undefined` and every terminal takes the local branch it always took, so
 * remote support is additive and its absence is not a degraded mode — it is the
 * mode this plugin shipped in.
 *
 * ## The session id crosses the wire unchanged, and that is the feature
 *
 * A remote Code terminal is started with the same `--session-id` a local one
 * would get, so the conversation the server writes is the conversation this
 * host named. That is what lets the session mirror bring it home under an id
 * the sidebar can click, and what lets clicking it start the remote launcher on
 * the very conversation the row is showing.
 * @module @omdsh-plugins/omdsh-code/src/remote
 */

import type { PtyLike } from './harness-pty.ts'

/** Cordis service name `omdsh-remdev` publishes under. */
export const REMDEV_SERVICE = 'remdev'

/** One remote workspace, as this plugin uses it. */
export interface RemoteWorkspaceFace {
  /** The directory on the server; what the terminal's banner will show. */
  readonly remotePath: string
  /** `user@host` of the server. */
  readonly authority: string
  /**
   * Start the remote harness on one session.
   * @param request - the grid, the conversation, and the profile to boot.
   * @returns the live terminal, shaped like a local one.
   */
  openAgent: (request: {
    cols: number
    rows: number
    sessionId: string
    /**
     * The profile to boot. Left out by this plugin on purpose: the server's
     * profile was created by whoever provisioned the server, and this
     * plugin's own profile name is a composition on the local machine.
     */
    profile?: string
  }) => Promise<PtyLike>
  /**
   * Pull this workspace's remote conversations down now.
   *
   * Called when a terminal's socket ends rather than only on the mirror's own
   * timer: the session log the accountant is about to look for was written by
   * the remote harness seconds ago, and waiting out an interval would leave the
   * row missing from the sidebar for that long.
   * @returns how many conversations were copied.
   */
  sync: () => Promise<number>
}

/** The service face, as much of it as this plugin uses. */
export interface RemdevFace {
  /**
   * The remote workspace a local directory stands in for.
   * @param cwd - an absolute local directory.
   * @returns the handle, or undefined for an ordinary local directory.
   */
  remoteFor: (cwd: string) => RemoteWorkspaceFace | undefined
}

/** How this plugin asks its context for the service. */
export type ResolveRemote = (cwd: string) => RemoteWorkspaceFace | undefined

/**
 * Build the resolver from a cordis context.
 *
 * Resolved on every call rather than once at activation: the service publishes
 * on its own plugin's lifetime, which can start after this one and can end and
 * come back under HMR — and a resolver that captured `undefined` at boot would
 * make a later-loading remote plugin invisible until a restart.
 * @param get - the context's service lookup, by name.
 * @returns the resolver.
 */
export function remoteResolver(get: (name: string) => unknown): ResolveRemote {
  return (cwd) => {
    const service = get(REMDEV_SERVICE) as RemdevFace | undefined
    return service?.remoteFor(cwd)
  }
}
