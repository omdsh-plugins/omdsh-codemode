/**
 * Getting a Code conversation into the sidebar, where the user left it.
 *
 * The web GUI lists every persisted session it can see, so a terminal
 * conversation already reaches the sidebar on its own — as a stray, under
 * **Ungrouped**, below every project. That is the wrong place for a
 * conversation the user started inside a workspace, and it is wrong for a
 * mechanical reason rather than a cosmetic one: a session appears in a
 * workspace group only when that workspace's durable account names it, and
 * only the process that created the session ever attaches it. Code mode's
 * terminal is a SEPARATE process — it knows nothing about the registry the web
 * host keeps — so nobody accounts for it and it stays loose forever.
 *
 * This is the missing attach, done by the half that can: the web host, which
 * holds the registry, knows the directory it just started a terminal in, and
 * named the session itself.
 *
 * **What gets accounted, and what must not.** Only a conversation that has
 * BEGUN — one a turn has run in. Not "one with a log", which is what this
 * module used to test and is not the same thing at all: the terminal app
 * writes its header the moment it starts, so a terminal opened and never typed
 * into leaves a real, tiny, turn-less log on disk. The web host reads such a
 * session as `blank`, and blank is not merely "hidden from the sidebar" — it
 * is the frame's word for **a conversation New Session may reuse**.
 * `workspaces.connectWorkspace` scans the workspace's account for one and
 * opens it, so a turn-less Code conversation sitting in that account is handed
 * to the user the next time they press New Session in any other mode: the
 * column turns back into a terminal, and the mode changes under them. It also
 * reaches the frame's initial workspace selection, which can open a page
 * straight into a terminal nobody asked for.
 *
 * Accounting one buys nothing to weigh against that — the sidebar hides blank
 * sessions, so the row it would produce is not drawn. Hence the rule this
 * module now enforces in both directions: a conversation that has begun is
 * attached, and one that has not is DETACHED if some earlier build attached
 * it ({@link WorkspaceAccountant.settleNow}, and
 * {@link WorkspaceAccountant.reconcileAccounts} for the ones left behind
 * before this rule existed).
 *
 * **Why it retries.** Beginning happens on the user's timing, not the
 * terminal's: the conversation exists from the first keystroke's turn, which
 * may be seconds after the terminal opened or minutes. So attaching cannot
 * happen at spawn; it happens whenever the conversation turns out to have
 * begun, which is why the schedule is a handful of widening attempts rather
 * than one call, why coming back to a terminal re-arms it, and why giving up
 * is silent — the surface asks again every time its socket ends.
 * @module @omdsh-plugins/omdsh-code/src/workspace-account
 */

import { isCodeSessionId } from './code-session.ts'

/**
 * The workspace registry as this plugin reads it — a structural mirror rather
 * than an import, the same shape `sessionModes` and `webRuntime` are read
 * through. `@deepseek-ai/dsh-workspace` publishes `workspaceRegistry`, cordis
 * resolves it by name at runtime, and a composition without it (a deployment
 * with no sidebar at all) must leave this plugin working rather than fail to
 * install.
 */
export interface WorkspaceRegistryFace {
  /**
   * The workspace registered at a directory.
   * @param path - an absolute directory.
   * @returns its workspace, or undefined when the directory is not registered.
   */
  resolveByPath(path: string): Promise<WorkspaceFace | undefined>
  /**
   * Every registered workspace, in display order. A synchronous projection
   * that reads no storage, which is what makes the sweep below affordable:
   * the only I/O it costs is one question per Code conversation already
   * accounted somewhere.
   * @returns the workspaces.
   */
  list(): readonly WorkspaceFace[]
}

/** One workspace, in the calls this plugin makes of it. */
export interface WorkspaceFace {
  /** Sessions the workspace already accounts for. */
  readonly sessionIds: readonly string[]
  /**
   * Record a session under this workspace.
   * @param sessionId - the session to account for; rejects while it has no
   * persisted header, which is exactly the "not typed into yet" case.
   */
  attachSession(sessionId: string): Promise<void>
  /**
   * Take a session back out of this workspace's account. Idempotent, and it
   * never touches the session's own stored log — the conversation is left
   * exactly as it was, minus a grouping it should not have had.
   * @param sessionId - the session to unaccount.
   */
  detachSession(sessionId: string): Promise<void>
}

/**
 * Whether one conversation has BEGUN — whether a turn has ever run in it.
 *
 * A function rather than a service, for the reason the registry is a resolver:
 * the answer lives behind a projection this plugin reads by name, and the
 * accounting rule is worth testing without composing one.
 *
 * Three answers, not two. `undefined` is "this deployment cannot tell right
 * now" — nothing persisted yet, no such projection composed, a storage fault —
 * and it is deliberately neither of the others: not a reason to account for a
 * conversation, and not a reason to take an existing account away.
 * @param sessionId - the conversation being asked about.
 * @returns true when a turn has run, false when demonstrably none has, and
 * undefined when the question has no answer here.
 */
export type ConversationBegun = (sessionId: string) => Promise<boolean | undefined>

/**
 * Delays before each attach attempt, in milliseconds.
 *
 * Widening rather than uniform: most Code sessions get their first turn within
 * seconds of the terminal opening, and a session still unbegun two minutes
 * later is one the user opened and walked away from — worth a last look, not a
 * standing poll. Each attempt costs the registry one session-header scan, so
 * the schedule is short on purpose. A schedule that runs out is not the end of
 * the matter either: coming back to the terminal re-arms it, and leaving Code
 * mode settles the account directly.
 */
export const ATTACH_SCHEDULE_MS: readonly number[] = [4_000, 12_000, 30_000, 90_000, 180_000]

/**
 * Delays before each attempt at the one-time sweep, in milliseconds.
 *
 * It waits at all only for the workspace registry, which publishes after this
 * plugin mounts; the first attempt that finds one is the last. Early on
 * purpose: the sweep is undoing accounts that make the frame open a terminal
 * on its own, and the frame's initial workspace selection happens as soon as a
 * page connects.
 */
export const RECONCILE_SCHEDULE_MS: readonly number[] = [500, 4_000, 20_000]

/** Sets the timers this accountant runs on; a spec replaces them. */
export interface AccountantClock {
  /**
   * Run a callback later.
   * @param callback - what to run.
   * @param delayMs - when.
   * @returns a handle {@link AccountantClock.clear} accepts.
   */
  setTimeout(callback: () => void, delayMs: number): unknown
  /**
   * Cancel a pending callback.
   * @param handle - what {@link AccountantClock.setTimeout} returned.
   */
  clear(handle: unknown): void
}

/** The process clock, with the unref every timer of this plugin's takes. */
const PROCESS_CLOCK: AccountantClock = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    // A pending attach must never be the reason a host process stays alive.
    timer.unref?.()
    return timer
  },
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** Keeps begun Code conversations accounted under the workspace they run in. */
export class WorkspaceAccountant {
  /** Sessions already accounted by this process, so their schedule stays stopped. */
  private readonly settled = new Set<string>()
  /** The pending attempt per session, so coming back re-arms rather than doubles. */
  private readonly runs = new Map<string, unknown>()
  private readonly pending = new Set<unknown>()
  private disposed = false

  /**
   * @param registry - resolves the workspace registry, or `undefined` in a
   * composition without one (every call then does nothing, the honest off
   * state). A RESOLVER rather than the service itself, and that is load
   * order rather than taste: the registry publishes only after its own
   * storage and session-persistence dependencies have started, which is
   * routinely after this plugin's, and a value read once at mount would be
   * `undefined` for the life of the process.
   * @param begun - whether a conversation has had a turn; see
   * {@link ConversationBegun}. A deployment that cannot answer keeps the
   * behaviour this module had before the question existed.
   * @param schedule - attempt delays; see {@link ATTACH_SCHEDULE_MS}.
   * @param clock - timer source, replaced by specs.
   */
  constructor(
    private readonly registry: () => WorkspaceRegistryFace | undefined,
    private readonly begun: ConversationBegun,
    private readonly schedule: readonly number[] = ATTACH_SCHEDULE_MS,
    private readonly clock: AccountantClock = PROCESS_CLOCK,
  ) {}

  /**
   * Account for one Code session under the workspace at `cwd`, once it has
   * begun.
   *
   * Calling it again for a session already accounted does nothing — that work
   * is done and durable. Calling it again for one still unbegun RE-ARMS the
   * schedule, because a second call is a second socket, which is the user back
   * in this terminal and about to type in it. The schedule that ran out while
   * they were away is exactly the one worth running again.
   * @param sessionId - the Code session the terminal drives.
   * @param cwd - the directory it runs in.
   */
  track(sessionId: string, cwd: string): void {
    if (this.disposed) return
    if (this.settled.has(sessionId)) return
    this.cancel(sessionId)
    this.attemptFrom(0, sessionId, cwd)
  }

  /**
   * Settle one conversation's account now, without waiting for the next
   * scheduled attempt — what leaving Code mode means, and the cheapest place
   * to be right about both directions.
   *
   * Begun conversations are attached. Unbegun ones are DETACHED when some
   * earlier attempt (or an earlier build of this plugin) accounted them:
   * a turn-less conversation in a workspace account is what the frame reuses
   * for New Session, so leaving one there turns the next New Session into a
   * terminal. See the module note.
   * @param sessionId - the Code session.
   * @param cwd - the directory it ran in.
   * @returns whether the session is now accounted.
   */
  async settleNow(sessionId: string, cwd: string): Promise<boolean> {
    const registry = this.registry()
    if (registry === undefined || this.disposed) return false
    try {
      const workspace = await registry.resolveByPath(cwd)
      // No workspace at this path: the terminal ran somewhere the sidebar does
      // not group, and a row there would have nowhere to live.
      if (workspace === undefined) return false
      const accounted = workspace.sessionIds.includes(sessionId)
      const begun = await this.begun(sessionId)
      if (begun === false) {
        if (accounted) await workspace.detachSession(sessionId)
        return false
      }
      // Unanswerable (`undefined`) leaves the account exactly as it is: a
      // deployment that cannot tell must not lose a grouping over the doubt,
      // and an unaccounted session is one `attachSession` would refuse anyway
      // while it has no persisted header.
      if (accounted) return true
      if (begun === undefined) return false
      await workspace.attachSession(sessionId)
      return true
    } catch {
      // A storage fault, or a registry that refused the attach. Neither is
      // worth a broken terminal, and neither is a reason to write anything.
      return false
    }
  }

  /**
   * Take every Code conversation that never began back out of the workspace
   * accounts — the one-time sweep for homes an earlier build already wrote to.
   *
   * The rule this class now upholds going forward says nothing about the
   * accounts already on disk, and those are where the bug lives for anyone who
   * has used Code mode before this version: every terminal they opened and did
   * not type into left a turn-less conversation accounted under its project,
   * and each one is a New Session away from putting a terminal back on screen.
   * Nothing visible is removed — the sidebar does not draw blank conversations
   * — and nothing durable about the conversation itself is touched.
   *
   * Fail-soft per conversation and sequential by design: it runs while the
   * host is starting, and one unreadable log must cost the sweep that log
   * rather than the rest of them.
   * @returns completion, once every account has been read.
   */
  async reconcileAccounts(): Promise<void> {
    const registry = this.registry()
    if (registry === undefined || this.disposed) return
    let workspaces: readonly WorkspaceFace[]
    try {
      workspaces = registry.list()
    } catch {
      return
    }
    for (const workspace of workspaces) {
      // Snapshotted per workspace: detaching rewrites the account, and the
      // getter is a live projection of it.
      for (const sessionId of [...workspace.sessionIds]) {
        if (this.disposed) return
        // This plugin's own conversations, and only those. Every other row in
        // the account belongs to a mode that never asked this one's opinion.
        if (!isCodeSessionId(sessionId)) continue
        let begun: boolean | undefined
        try {
          begun = await this.begun(sessionId)
        } catch {
          continue
        }
        if (begun !== false) continue
        try {
          await workspace.detachSession(sessionId)
        } catch {
          // One refused write is one grouping left wrong, not a sweep abandoned.
        }
      }
    }
  }

  /**
   * Run {@link WorkspaceAccountant.reconcileAccounts} once the workspace
   * registry has published, retrying only for want of one.
   * @param schedule - attempt delays; see {@link RECONCILE_SCHEDULE_MS}.
   */
  reconcileSoon(schedule: readonly number[] = RECONCILE_SCHEDULE_MS): void {
    this.reconcileFrom(0, schedule)
  }

  /** Stop every pending attempt (plugin teardown). */
  dispose(): void {
    this.disposed = true
    for (const handle of this.pending) this.clock.clear(handle)
    this.pending.clear()
    this.runs.clear()
  }

  /**
   * Run attempt `index`, scheduling the next one when it did not land.
   * @param index - position in {@link WorkspaceAccountant.schedule}.
   * @param sessionId - the Code session.
   * @param cwd - the directory it runs in.
   */
  private attemptFrom(index: number, sessionId: string, cwd: string): void {
    const delay = this.schedule[index]
    if (delay === undefined || this.disposed) return
    const handle = this.clock.setTimeout(() => {
      this.pending.delete(handle)
      this.runs.delete(sessionId)
      void this.settleNow(sessionId, cwd).then((attached) => {
        if (attached) this.settled.add(sessionId)
        else this.attemptFrom(index + 1, sessionId, cwd)
      })
    }, delay)
    this.pending.add(handle)
    this.runs.set(sessionId, handle)
  }

  /**
   * Run sweep attempt `index`, retrying only while no registry has published.
   * @param index - position in `schedule`.
   * @param schedule - the attempt delays.
   */
  private reconcileFrom(index: number, schedule: readonly number[]): void {
    const delay = schedule[index]
    if (delay === undefined || this.disposed) return
    const handle = this.clock.setTimeout(() => {
      this.pending.delete(handle)
      if (this.registry() === undefined) {
        this.reconcileFrom(index + 1, schedule)
        return
      }
      void this.reconcileAccounts()
    }, delay)
    this.pending.add(handle)
  }

  /** Drop one conversation's pending attempt, if it has one. */
  private cancel(sessionId: string): void {
    const handle = this.runs.get(sessionId)
    if (handle === undefined) return
    this.clock.clear(handle)
    this.pending.delete(handle)
    this.runs.delete(sessionId)
  }
}
