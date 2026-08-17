/**
 * Keeping the sidebar's name for a Code conversation honest while a terminal
 * is renaming it.
 *
 * `/rename` in the terminal is a durable change made by ANOTHER process. The
 * web host holds no agent for that conversation, so nothing pushes the new
 * name to this page: the sidebar goes on showing the old one until the next
 * baseline pull, which otherwise means the next reload.
 *
 * The terminal does announce it, though, through the oldest channel there is —
 * the window title (`OSC 0`), which every terminal program writes and every
 * emulator parses, this column's included. That announcement is the trigger
 * here. What it is NOT is the answer: the string is the terminal's own label
 * (`<session title> — <program>`), and a surface that parsed it would be
 * reading another package's formatting. The announcement says *something
 * changed*; the session list stays the authority on what the name IS.
 *
 * **Why a schedule rather than one pull.** The rename is durable on the
 * terminal's own timing: the projection cache the host reads cold titles from
 * is write-behind (a few seconds, or the next turn boundary), so a pull fired
 * the instant the title is announced can read the old row and be right to. The
 * attempts widen, and each one first checks whether the list already moved —
 * so the ordinary rename costs one or two reads and a session that never
 * settles costs a bounded few.
 * @module @omdsh-plugins/omdsh-codemode/src/client/title-sync
 */

/**
 * Delays before each baseline pull after a terminal announces a new name, in
 * milliseconds. See the module note: the first is for a rename already
 * flushed, the second covers the write-behind throttle, the last is the
 * give-up look.
 */
export const TITLE_REFRESH_SCHEDULE_MS: readonly number[] = [1_000, 6_000, 15_000]

/** Sets the timers this sync runs on; a spec replaces them. */
export interface TitleSyncClock {
  /**
   * Run a callback later.
   * @param callback - what to run.
   * @param delayMs - when.
   * @returns a handle {@link TitleSyncClock.clear} accepts.
   */
  setTimeout(callback: () => void, delayMs: number): unknown
  /**
   * Cancel a pending callback.
   * @param handle - what {@link TitleSyncClock.setTimeout} returned.
   */
  clear(handle: unknown): void
}

/** The browser clock. */
const BROWSER_CLOCK: TitleSyncClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** What this sync reaches outside itself. */
export interface TitleSyncDeps {
  /**
   * The durable name the session list carries for one conversation, when it
   * carries one. Read before and after each pull: a change here is the whole
   * stop condition.
   * @param sessionId - the conversation being watched.
   * @returns its listed title, or undefined while it has none.
   */
  listedTitle(sessionId: string): string | undefined
  /** Re-pull the Host's session baseline. */
  refresh(): void
}

/** Re-reads the session list until a renamed conversation's row catches up. */
export class TerminalTitleSync {
  /** The last title each terminal announced, so only a CHANGE starts a run. */
  private readonly announcedTitles = new Map<string, string>()

  /** Pending timers per conversation, so a second rename replaces the first run. */
  private readonly runs = new Map<string, unknown>()

  private disposed = false

  /**
   * @param deps - see {@link TitleSyncDeps}.
   * @param schedule - pull delays; see {@link TITLE_REFRESH_SCHEDULE_MS}.
   * @param clock - timer source, replaced by specs.
   */
  constructor(
    private readonly deps: TitleSyncDeps,
    private readonly schedule: readonly number[] = TITLE_REFRESH_SCHEDULE_MS,
    private readonly clock: TitleSyncClock = BROWSER_CLOCK,
  ) {}

  /**
   * A terminal announced its window title.
   *
   * The FIRST announcement for a conversation is a greeting, not news: a
   * terminal states its title when it starts, and a reconnect replays that
   * write with the rest of the transcript. It is recorded and nothing else, so
   * entering Code mode costs no reads.
   * @param sessionId - the Code conversation the terminal drives.
   * @param title - the announced window title, verbatim.
   */
  announced(sessionId: string, title: string): void {
    if (this.disposed) return
    const previous = this.announcedTitles.get(sessionId)
    this.announcedTitles.set(sessionId, title)
    if (previous === undefined || previous === title) return
    this.cancel(sessionId)
    this.attemptFrom(0, sessionId, this.deps.listedTitle(sessionId))
  }

  /** Stop every pending pull (the column going away, or the plugin unloading). */
  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.runs.keys()]) this.cancel(sessionId)
    this.announcedTitles.clear()
  }

  /**
   * Run attempt `index`: stop if the list already moved, else pull and
   * schedule the next.
   * @param index - position in {@link TerminalTitleSync.schedule}.
   * @param sessionId - the conversation being watched.
   * @param before - its listed title when the announcement arrived.
   */
  private attemptFrom(index: number, sessionId: string, before: string | undefined): void {
    const delay = this.schedule[index]
    if (delay === undefined || this.disposed) return
    const handle = this.clock.setTimeout(() => {
      this.runs.delete(sessionId)
      if (this.disposed) return
      // The row already says something else — the pull that produced it may
      // have been this run's or anyone's, and either way there is nothing
      // left to wait for.
      if (this.deps.listedTitle(sessionId) !== before) return
      this.deps.refresh()
      this.attemptFrom(index + 1, sessionId, before)
    }, delay)
    this.runs.set(sessionId, handle)
  }

  /** Drop one conversation's pending attempt, if it has one. */
  private cancel(sessionId: string): void {
    const handle = this.runs.get(sessionId)
    if (handle === undefined) return
    this.clock.clear(handle)
    this.runs.delete(sessionId)
  }
}
