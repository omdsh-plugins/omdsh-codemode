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
 * **Why it retries.** A session materializes lazily: `dsh` writes nothing to
 * disk until the first turn, so a terminal the user opened and never typed
 * into leaves no log — deliberately, and this module preserves that (an
 * unmaterialized session is simply never accounted, so an idle Code terminal
 * adds no sidebar row). Attaching therefore cannot happen at spawn; it happens
 * whenever the session turns out to exist, which is why the schedule is a
 * handful of widening attempts rather than one call, and why giving up is
 * silent.
 * @module @omdsh-plugins/omdsh-code/src/workspace-account
 */

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
}

/** One workspace, in the two calls this plugin makes of it. */
export interface WorkspaceFace {
  /** Sessions the workspace already accounts for. */
  readonly sessionIds: readonly string[]
  /**
   * Record a session under this workspace.
   * @param sessionId - the session to account for; rejects while it has no
   * persisted header, which is exactly the "not typed into yet" case.
   */
  attachSession(sessionId: string): Promise<void>
}

/**
 * Delays before each attach attempt, in milliseconds.
 *
 * Widening rather than uniform: most Code sessions get their first turn within
 * seconds of the terminal opening, and a session still unwritten two minutes
 * later is one the user opened and walked away from — worth a last look, not a
 * standing poll. Each attempt costs the registry one session-header scan, so
 * the schedule is short on purpose.
 */
export const ATTACH_SCHEDULE_MS: readonly number[] = [4_000, 12_000, 30_000, 90_000, 180_000]

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

/** Keeps Code sessions accounted under the workspace they run in. */
export class WorkspaceAccountant {
  /** Sessions with an attempt sequence running or finished, so `track` is idempotent. */
  private readonly tracked = new Set<string>()
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
   * @param schedule - attempt delays; see {@link ATTACH_SCHEDULE_MS}.
   * @param clock - timer source, replaced by specs.
   */
  constructor(
    private readonly registry: () => WorkspaceRegistryFace | undefined,
    private readonly schedule: readonly number[] = ATTACH_SCHEDULE_MS,
    private readonly clock: AccountantClock = PROCESS_CLOCK,
  ) {}

  /**
   * Account for one Code session under the workspace at `cwd`, once it exists.
   * Repeated calls for the same session are ignored: the schedule already
   * running is the same schedule a second call would start.
   * @param sessionId - the Code session the terminal drives.
   * @param cwd - the directory it runs in.
   */
  track(sessionId: string, cwd: string): void {
    if (this.disposed) return
    if (this.tracked.has(sessionId)) return
    this.tracked.add(sessionId)
    this.attemptFrom(0, sessionId, cwd)
  }

  /**
   * Attach now, without waiting for the next scheduled attempt — what a
   * terminal exiting means, since a session unwritten by then never will be.
   * @param sessionId - the Code session.
   * @param cwd - the directory it ran in.
   * @returns whether the session is now accounted.
   */
  async attachNow(sessionId: string, cwd: string): Promise<boolean> {
    const registry = this.registry()
    if (registry === undefined || this.disposed) return false
    try {
      const workspace = await registry.resolveByPath(cwd)
      // No workspace at this path: the terminal ran somewhere the sidebar does
      // not group, and a row there would have nowhere to live.
      if (workspace === undefined) return false
      if (workspace.sessionIds.includes(sessionId)) return true
      await workspace.attachSession(sessionId)
      return true
    } catch {
      // The ordinary case is "no persisted header yet", which the registry
      // reports as a rejection; a storage fault reads the same from here and
      // is equally not worth a broken terminal.
      return false
    }
  }

  /** Stop every pending attempt (plugin teardown). */
  dispose(): void {
    this.disposed = true
    for (const handle of this.pending) this.clock.clear(handle)
    this.pending.clear()
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
      void this.attachNow(sessionId, cwd).then((attached) => {
        if (!attached) this.attemptFrom(index + 1, sessionId, cwd)
      })
    }, delay)
    this.pending.add(handle)
  }
}
