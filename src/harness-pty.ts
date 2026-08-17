/**
 * The terminals behind Code mode: one harness TUI per Code session.
 *
 * Keyed by the SESSION the terminal drives, not by the directory it runs in
 * and not by the web conversation that opened it. The key follows from naming
 * the session ([code-session](./code-session.ts)): a terminal is the live view
 * of one conversation, so two surfaces asking for the same Code session must
 * land on the same process — and asking for a different one, which is what
 * clicking another Code row in the sidebar does, must open that conversation
 * rather than whatever the directory last had.
 *
 * That is a deliberate change from keying by directory. A directory key made
 * "one agent per tree" structural, but it also made a Code conversation
 * unaddressable: the only terminal a workspace could have was its most recent
 * one, so a session the user left could never be brought back. Two terminals
 * in one tree are now possible and are the user's own explicit act — the same
 * thing two `dsh` windows in one directory have always been.
 *
 * A terminal outlives its WebSocket on purpose. Leaving Code mode, switching
 * conversations, and reloading the page all drop the socket, and none of them
 * mean "kill my agent mid-turn" — so the process stays, its output keeps
 * accumulating into a bounded transcript, and the next connection replays that
 * transcript before going live. What DOES end one is the user exiting it, the
 * grace expiring, or this plugin unloading.
 *
 * ## Local and remote are the same table
 *
 * A workspace that lives on a server runs its agent there, and this table does
 * not branch on which. It holds {@link PtyLike} — the five members the bridge
 * actually drives — and is handed a SPAWNER that decides. Everything above (the
 * naming rules, the transcript, the title scan, the reconnect grace) is about a
 * conversation rather than a machine, and none of it wanted to know.
 * @module @omdsh-plugins/omdsh-codemode/src/harness-pty
 */

import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as nodePty from 'node-pty'
import { readOscTitle } from './osc-title.ts'
import { CodeError, messageOf } from './wire.ts'

/** Transcript bytes kept per terminal for replay on reconnect. */
export const TRANSCRIPT_LIMIT = 1 << 20

/**
 * How much of the tail is scanned for a window title after each read. Wide
 * enough that a title split across two pty reads is whole by the second, and
 * narrow enough that the scan costs nothing on a busy terminal.
 */
export const TITLE_SCAN_TAIL = 2048

/** How long a terminal survives a bare socket drop before it is reaped. */
export const RECONNECT_GRACE_MS = 5 * 60 * 1000

/** The profile Code mode boots when a deployment names none. */
export const DEFAULT_PROFILE = 'omdsh-tui'

/** What to run, already resolved to an argv. */
export interface HarnessCommand {
  /** Executable. */
  readonly file: string
  /** Its arguments. */
  readonly args: readonly string[]
}

/** A subscription that can be dropped. */
export interface PtyDisposable {
  /** Stop listening. */
  dispose: () => void
}

/**
 * A terminal, as the bridge drives one.
 *
 * Exactly node-pty's shape for the five members this plugin touches, so a local
 * `IPty` satisfies it without an adapter and a remote implementation has an
 * unambiguous target to hit.
 */
export interface PtyLike {
  /** Be told each chunk of output. */
  onData: (listener: (data: string) => void) => PtyDisposable
  /** Be told once when the terminal ends. */
  onExit: (listener: (status: { exitCode: number; signal?: number | undefined }) => void) => PtyDisposable
  /** Send keystrokes. */
  write: (data: string) => void
  /** Change the grid. */
  resize: (cols: number, rows: number) => void
  /** End it now. */
  kill: () => void
}

/**
 * How a terminal is made for one Code session.
 *
 * Asynchronous because a remote one is: allocating a pty on a server is a round
 * trip, and provisioning `.dsh-server` on a machine that has never had it may
 * be several. The local spawner resolves immediately.
 */
export type PtySpawner = (
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
) => Promise<PtyLike>

/** One live terminal. */
export interface CodeTerminal {
  /** The Code session this terminal drives; also its key. */
  sessionId: string
  /** The directory it was spawned in. */
  cwd: string
  /**
   * Whether the surface NAMED this conversation when it attached (a Code row
   * it was clicked on) rather than asking for the directory's terminal.
   *
   * It decides one thing: whether this terminal answers a later socket that
   * names nothing ({@link HarnessTerminalRegistry.liveIn}). A named one does
   * not, because "the terminal for this project" is not "whichever
   * conversation was opened last" — and because a named conversation is the
   * only kind that can fail to start at all: it may be held by another
   * process, and a terminal that could not take its session must not become
   * the one every later press of Code lands on.
   */
  named: boolean
  /** The process, local or remote. */
  pty: PtyLike
  /** Output since spawn, head-dropped past {@link TRANSCRIPT_LIMIT}. */
  transcript: string
  /**
   * The window title this terminal last announced, or undefined before it has
   * announced one. Kept so a change can be told from a repeat — see
   * {@link HarnessTerminalRegistry} and [osc-title](./osc-title.ts).
   */
  title?: string
  /** True once the top-level process exited; the transcript stays replayable. */
  exited: boolean
}

/**
 * Restore the executable bit pnpm strips from node-pty's prebuilt
 * spawn-helper (the macOS helper that forks and sets up the pty). Without it
 * every spawn fails with `posix_spawnp failed`. Idempotent.
 */
export function ensureSpawnHelper(): void {
  if (process.platform === 'win32') return
  try {
    const require = createRequire(import.meta.url)
    const packageRoot = dirname(dirname(require.resolve('node-pty')))
    const candidates = [
      join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(packageRoot, 'build', 'Release', 'spawn-helper'),
    ]
    for (const helper of candidates) if (existsSync(helper)) chmodSync(helper, 0o755)
  } catch {
    // Resolution or chmod failure: the spawn below surfaces its own error to
    // the surface, which is where a person can actually read it.
  }
}

/**
 * The command that boots the harness terminal.
 *
 * Re-executing THIS process's own entry rather than looking for `dsh` on the
 * PATH: the runtime serving this page is already a dsh launch, so its entry is
 * the one launcher known to exist and known to be the same installation the
 * user is talking to. A packaged application whose runtime was started some
 * other way overrides the pair explicitly.
 * @param profile - the profile name to boot.
 * @param override - an explicit command from configuration.
 * @returns the resolved command.
 * @throws {CodeError} when neither this process's entry nor an override names one.
 */
export function resolveHarnessCommand(
  profile: string,
  override: { command?: string; args?: readonly string[] } = {},
): HarnessCommand {
  if (override.command !== undefined && override.command !== '') {
    return { file: override.command, args: [...override.args ?? []] }
  }
  const entry = process.argv[1]
  if (entry === undefined || entry === '') {
    throw new CodeError(
      'no-launcher',
      'this runtime was started without a resolvable entry module; set `command` to the dsh launcher',
    )
  }
  return { file: process.execPath, args: [...process.execArgv, entry, '--profile', profile] }
}

/**
 * The argv that boots one named Code session.
 *
 * `--session-id` is the terminal app's create-or-continue key: the first
 * launch under an id creates that session, every later one continues it. Code
 * mode names the session before the process exists because it has to account
 * for it afterwards — see [code-session](./code-session.ts) — and this is the
 * one flag that carries the name across.
 *
 * A deployment that overrode `command` is telling this plugin what its dsh
 * launcher is, so the flag rides that too; a launcher which does not
 * understand it is not a launcher this mode can drive.
 * @param command - the resolved launcher.
 * @param sessionId - the Code session the terminal drives.
 * @returns the command with the session named.
 */
export function commandForSession(command: HarnessCommand, sessionId: string): HarnessCommand {
  return { file: command.file, args: [...command.args, '--session-id', sessionId] }
}

/** The terminal table. One entry per Code session, at most. */
export class HarnessTerminalRegistry {
  private readonly live = new Map<string, CodeTerminal>()
  private readonly reaps = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * @param command - what every terminal runs.
   * @param graceMs - how long a dropped socket's terminal survives.
   * @param onRenamed - a terminal announced a NEW window title, which is how a
   * conversation renamed inside one becomes visible to this process; the first
   * announcement of a terminal's life is its greeting and is not reported.
   */
  constructor(
    private readonly command: HarnessCommand,
    private readonly graceMs: number = RECONNECT_GRACE_MS,
    private readonly onRenamed?: (terminal: CodeTerminal) => void,
    /**
     * Asked first for every attach; answering `undefined` means this directory
     * is an ordinary local one and the local spawner takes it.
     */
    private readonly remote?: (cwd: string) => PtySpawner | undefined,
  ) {
    // Here rather than at plugin activation: a registry that cannot spawn is
    // useless whoever built it, and a spec constructing one directly must get
    // the same working table the plugin does.
    ensureSpawnHelper()
  }

  /**
   * Attach to a Code session's terminal, spawning one when it has none or has
   * an exited one. Attaching cancels any pending reap.
   *
   * Spawning is the same call whether the session is new or is being brought
   * back: the terminal app creates the named session on first use and
   * continues it afterwards, so this table never has to know which it is.
   * @param sessionId - the Code session to show.
   * @param cwd - the directory it runs in.
   * @param cols - initial width in cells.
   * @param rows - initial height in cells.
   * @param named - whether the surface asked for this exact conversation; see
   * {@link CodeTerminal.named}.
   * @returns the live terminal.
   * @throws {CodeError} pty-error when the terminal could not be spawned.
   */
  async attach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    named = false,
  ): Promise<CodeTerminal> {
    this.cancelReap(sessionId)
    const existing = this.live.get(sessionId)
    if (existing !== undefined && !existing.exited) return existing
    if (existing !== undefined) this.close(sessionId)

    const spawn = this.remote?.(cwd) ?? this.localSpawner()
    const pty = await spawn(sessionId, cwd, clampDimension(cols), clampDimension(rows))

    const terminal: CodeTerminal = { sessionId, cwd, named, pty, transcript: '', exited: false }
    pty.onData((data) => {
      terminal.transcript = capTranscript(terminal.transcript + data)
      this.readTitle(terminal)
    })
    pty.onExit(() => { terminal.exited = true })
    this.live.set(sessionId, terminal)
    return terminal
  }

  /**
   * The live terminal of a Code session, when there is one.
   * @param sessionId - the Code session.
   * @returns its terminal, or undefined.
   */
  get(sessionId: string): CodeTerminal | undefined {
    return this.live.get(sessionId)
  }

  /**
   * This host's live terminal in a directory — what "the terminal for this
   * project" means when the surface has not named a conversation.
   *
   * A FACT, and that matters: the alternative is guessing from the session
   * list, which after a restart names the very conversation the previous
   * host's terminal is most likely still holding — and two processes on one
   * session log is the collision the harness refuses. This table only ever
   * reports processes this host started and has not reaped.
   *
   * The most recent one wins where a directory has several (the user opened an
   * older Code conversation beside the current one), because the newest is the
   * one they were last in.
   * @param cwd - the workspace directory.
   * @returns its newest live terminal, or undefined.
   */
  liveIn(cwd: string): CodeTerminal | undefined {
    let found: CodeTerminal | undefined
    // Map iteration is insertion-ordered, so the last match is the newest
    // attach — and neither an exited process nor a terminal opened for a
    // named conversation is one to hand back here.
    for (const terminal of this.live.values()) {
      if (terminal.cwd === cwd && !terminal.exited && !terminal.named) found = terminal
    }
    return found
  }

  /**
   * Schedule a terminal's end. A socket drop asks for the reconnect grace (a
   * refresh or a mode switch must find the same agent); an explicit close asks
   * for zero.
   * @param sessionId - the Code session.
   * @param delayMs - how long to wait; {@link attach} cancels a pending reap.
   */
  scheduleClose(sessionId: string, delayMs: number = this.graceMs): void {
    if (!this.live.has(sessionId)) return
    this.cancelReap(sessionId)
    if (delayMs <= 0) {
      this.close(sessionId)
      return
    }
    const timer = setTimeout(() => { this.close(sessionId) }, delayMs)
    // A pending reap must never be the reason a host process stays alive.
    timer.unref?.()
    this.reaps.set(sessionId, timer)
  }

  /**
   * End a terminal now and drop its transcript.
   * @param sessionId - the Code session.
   */
  close(sessionId: string): void {
    this.cancelReap(sessionId)
    const terminal = this.live.get(sessionId)
    if (terminal === undefined) return
    this.live.delete(sessionId)
    try {
      terminal.pty.kill()
    } catch {
      // Already gone; there is nothing left to kill.
    }
  }

  /** End every terminal (plugin teardown). */
  disposeAll(): void {
    for (const sessionId of [...this.live.keys()]) this.close(sessionId)
  }

  /**
   * Notice a terminal announcing a new window title.
   *
   * Read from the tail of the accumulated transcript rather than from the
   * chunk, because a pty read can cut an escape sequence in half and the
   * transcript is where the halves meet. The first announcement is the
   * terminal saying hello — every program sets a title when it starts — and
   * only what comes after it is news.
   * @param terminal - the terminal whose output just grew.
   */
  private readTitle(terminal: CodeTerminal): void {
    const announced = readOscTitle(terminal.transcript.slice(-TITLE_SCAN_TAIL))
    if (announced === undefined || announced === terminal.title) return
    const greeting = terminal.title === undefined
    terminal.title = announced
    if (!greeting) this.onRenamed?.(terminal)
  }

  /**
   * The spawner for a directory on this machine.
   * @returns a spawner that re-executes this runtime's launcher there.
   */
  private localSpawner(): PtySpawner {
    return (sessionId, cwd, cols, rows) => {
      const command = commandForSession(this.command, sessionId)
      try {
        return Promise.resolve(nodePty.spawn(command.file, [...command.args], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: {
            ...process.env,
            // The surface is a real terminal emulator; say so, and let the
            // banner take its 24-bit gradient rather than the fallback ramp.
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
          } as Record<string, string>,
        }))
      } catch (error) {
        return Promise.reject(
          new CodeError('pty-error', `cannot start the harness terminal: ${messageOf(error)}`),
        )
      }
    }
  }

  /** Cancel a pending reap, if this session has one. */
  private cancelReap(sessionId: string): void {
    const timer = this.reaps.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.reaps.delete(sessionId)
  }
}

/**
 * Keep a transcript within its bound by dropping from the head — the tail is
 * the part a reconnecting surface needs to see.
 * @param transcript - the accumulated output.
 * @returns the bounded transcript.
 */
export function capTranscript(transcript: string): string {
  return transcript.length <= TRANSCRIPT_LIMIT
    ? transcript
    : transcript.slice(transcript.length - TRANSCRIPT_LIMIT)
}

/**
 * A terminal dimension the pty will accept: a whole number of cells, at least
 * two (a one-cell grid breaks line editing everywhere).
 * @param value - the client's reported dimension.
 * @returns the clamped dimension.
 */
export function clampDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(2, Math.min(1000, Math.floor(value))) : 24
}
