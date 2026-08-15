/**
 * Making the web host re-read a conversation a terminal changed underneath it.
 *
 * The sidebar's name for a cold conversation comes from the projection cache:
 * a durable row per session, written by whichever process was running it, read
 * by whichever process is listing it. Both surfaces share the file, and that
 * is how a terminal's conversations get names in the web sidebar at all.
 *
 * What the reader does NOT do is read it twice. The web host loads that table
 * when it starts and serves every later `session.list` from memory, so a
 * rename made in a terminal — a durable change, correctly written, by another
 * process — is invisible here until the host restarts. Refreshing the browser
 * does not help; the staleness is behind the RPC, not in front of it.
 *
 * The cache's own cold read is the way back in: it refolds the session from
 * its log (which the terminal did write) and stores the result, which is
 * exactly the row `session.list` serves. So this module asks for that read at
 * the moment a terminal says its title changed.
 *
 * **Why a schedule.** The terminal makes the rename durable on its own timing
 * — the log flush and the cache write are write-behind, a few seconds or the
 * next turn boundary — so a read fired the instant the title is announced can
 * legitimately still see the old name. The attempts widen, stop as soon as the
 * folded name moves, and are a bounded few either way.
 * @module @omdsh-plugins/omdsh-code/src/title-refold
 */

/**
 * The persisted projection cache as this plugin reads it — a structural mirror
 * rather than an import, like every other harness service this plugin reaches
 * by name. `@deepseek-ai/dsh-session-projection-cache` publishes
 * `sessionProjectionCache`; a deployment composed without it lists no cold
 * titles at all, so its absence makes this module a no-op rather than an error.
 */
export interface ProjectionCacheFace {
  /**
   * Refold one persisted session's projections from its log and store the
   * result — the read that also makes this process's listing current.
   * @param sessionId - the session to re-read.
   * @returns its projected values, cut at the stored log end.
   */
  coldSnapshot(sessionId: string): Promise<{ asOfSeq: number; values: Record<string, unknown> }>
}

/**
 * Delays before each re-read, in milliseconds. Deliberately ahead of the
 * browser half's own schedule ([title-sync](./client/title-sync.ts)), so each
 * list the surface pulls is served from a row this side already refreshed.
 */
export const REFOLD_SCHEDULE_MS: readonly number[] = [500, 3_000, 8_000]

/** Sets the timers this refolder runs on; a spec replaces them. */
export interface RefoldClock {
  /**
   * Run a callback later.
   * @param callback - what to run.
   * @param delayMs - when.
   * @returns a handle {@link RefoldClock.clear} accepts.
   */
  setTimeout(callback: () => void, delayMs: number): unknown
  /**
   * Cancel a pending callback.
   * @param handle - what {@link RefoldClock.setTimeout} returned.
   */
  clear(handle: unknown): void
}

/** The process clock, with the unref every timer of this plugin's takes. */
const PROCESS_CLOCK: RefoldClock = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    // A pending re-read must never be the reason a host process stays alive.
    timer.unref?.()
    return timer
  },
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** Re-reads a conversation this process holds a stale name for. */
export class ProjectionRefolder {
  /** Pending attempts per session, so a second rename replaces the first run. */
  private readonly runs = new Map<string, unknown>()
  private disposed = false

  /**
   * @param cache - resolves the projection cache, or undefined in a
   * composition without one. A RESOLVER for the same reason the workspace
   * accountant takes one: the service publishes after this plugin mounts.
   * @param schedule - attempt delays; see {@link REFOLD_SCHEDULE_MS}.
   * @param clock - timer source, replaced by specs.
   */
  constructor(
    private readonly cache: () => ProjectionCacheFace | undefined,
    private readonly schedule: readonly number[] = REFOLD_SCHEDULE_MS,
    private readonly clock: RefoldClock = PROCESS_CLOCK,
  ) {}

  /**
   * A terminal renamed this conversation; re-read it until the fold agrees.
   * @param sessionId - the Code conversation the terminal drives.
   */
  renamed(sessionId: string): void {
    if (this.disposed) return
    this.cancel(sessionId)
    this.attemptFrom(0, sessionId, undefined)
  }

  /** Stop every pending re-read (plugin teardown). */
  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.runs.keys()]) this.cancel(sessionId)
  }

  /**
   * Run attempt `index`, scheduling the next unless the name already moved.
   * @param index - position in {@link ProjectionRefolder.schedule}.
   * @param sessionId - the conversation being re-read.
   * @param before - the name the first attempt folded; undefined on that attempt.
   */
  private attemptFrom(index: number, sessionId: string, before: string | undefined): void {
    const delay = this.schedule[index]
    if (delay === undefined || this.disposed) return
    const handle = this.clock.setTimeout(() => {
      this.runs.delete(sessionId)
      void this.refold(sessionId).then((title) => {
        if (this.disposed) return
        // The first attempt is the baseline: it may already carry the new name
        // (a title written at a turn boundary is durable the moment it is
        // announced), and it may not (a `/rename` waits for the write-behind).
        // Either way the row it stored is what this process now lists.
        if (index > 0 && title !== before) return
        this.attemptFrom(index + 1, sessionId, index === 0 ? title : before)
      })
    }, delay)
    this.runs.set(sessionId, handle)
  }

  /**
   * One cold read, fail-soft.
   *
   * A conversation with nothing written yet — a terminal nobody has typed into
   * — has no log to fold, which the cache reports as a rejection; so does a
   * storage fault. Neither is worth surfacing: the name on screen stays what
   * it was, which is the state this whole module is trying to improve on.
   * @param sessionId - the conversation to re-read.
   * @returns its folded title, or undefined.
   */
  private async refold(sessionId: string): Promise<string | undefined> {
    const cache = this.cache()
    if (cache === undefined) return undefined
    try {
      const snapshot = await cache.coldSnapshot(sessionId)
      const title = snapshot.values.title
      return typeof title === 'string' ? title : undefined
    } catch {
      return undefined
    }
  }

  /** Drop one conversation's pending attempt, if it has one. */
  private cancel(sessionId: string): void {
    const handle = this.runs.get(sessionId)
    if (handle === undefined) return
    this.clock.clear(handle)
    this.runs.delete(sessionId)
  }
}
