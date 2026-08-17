/**
 * Which terminal Code mode shows, and when it takes the column by itself.
 *
 * Three questions, all answered from the two lists the frame already
 * publishes plus the ids this plugin mints:
 *
 * 1. **Where does the terminal run?** The workspace the current conversation
 *    is grouped under, falling back to the session's own recorded directory.
 * 2. **Which conversation does it show?** The current session when that is a
 *    Code session (the user clicked its row), else the terminal this page was
 *    already shown for that directory, else none — which leaves the answer to
 *    the host, whose own live terminals are the only trustworthy source for
 *    "the terminal for this project".
 * 3. **What does New Session mean here?** Another Code conversation, in the
 *    project the request named or the one the terminal on screen is in — not a
 *    web conversation and not a change of mode. The id is minted here (see
 *    {@link CodeModeController.startNewConversation}) because nothing else in
 *    the system knows about a conversation that has not had its first turn yet.
 * 4. **What does pressing Code mean with nothing open?** A terminal needs a
 *    DIRECTORY, and a conversation is only one of the ways to name one — so a
 *    press with nothing on screen starts a terminal in the project the runtime
 *    itself would land in ({@link CodeModeController.ensureScope}), and a press
 *    with no project registered anywhere asks where, through the Host's own
 *    picker ({@link CodeModeController.chooseProject}). Neither derives; both
 *    happen on the press, so a page nobody pressed Code on starts nothing.
 *
 *    This is where the mode was dead before. Its availability was the scope's,
 *    the scope is derived from the selection, and nothing selects a
 *    conversation on a fresh install — a case invisible for as long as
 *    `omdsh-chatmode` was composed beside it, because its managed Chat
 *    workspace means a conversation is always open.
 * 5. **Who pressed Code?** Opening a Code conversation IS pressing Code:
 *    clicking that row anywhere — the sidebar, search, the flat list — means
 *    "show me this terminal", so the column follows the selection instead of
 *    waiting for a second gesture on the switch. And opening anything else is
 *    leaving Code, which the mode switch performs: Chat and Work re-derive
 *    themselves on every navigation, and the registry allows one active
 *    segment.
 *
 * What this deliberately does NOT do is pick the newest Code conversation in
 * the directory out of the session list. It looks like the same answer and is
 * not: after a host restart that conversation is the one the previous host's
 * terminal is most likely still holding, and reviving it starts a second
 * process on one session log — which the harness refuses, correctly, in the
 * user's face. The host answers from its own live table instead.
 *
 * A stored "current mode" would answer none of these better and would
 * eventually disagree with the sidebar. Nothing here is written down.
 * @module @omdsh-plugins/omdsh-codemode/src/client/code-mode
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ObservableSnapshot, SessionId, SessionListState, SnapshotStore, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { isCodeSessionId, mintCodeSessionId } from '../code-session.ts'
import type { Scope } from './api.ts'
import type { ColumnScope } from './session-modes.ts'

/** Everything the controller reaches outside itself, so a spec can drive it whole. */
export interface CodeModeDeps {
  /** The live session list (current selection, directories, recency). */
  readonly sessions: ObservableSnapshot<SessionListState>
  /** The live workspace list — which group a conversation is accounted under. */
  readonly workspaces: ObservableSnapshot<WorkspaceListState>
  /** Take the column for Code mode; the segment registry clears the others. */
  enterCode(): void
  /**
   * Drop the runtime's current selection.
   *
   * Used for one thing: a Code conversation that a build before this one left
   * selected. The runtime restores its selection on load, and a selected
   * conversation is one this host resumes — which is exactly what must not
   * happen to a conversation a terminal owns.
   */
  clearSelection(): void
  /**
   * Re-pull the Host's session baseline. Called when a workspace account names
   * a Code conversation the list has never heard of — the row cannot render
   * until its summary lands, and the baseline is only pulled on connect.
   */
  refreshSessions(): void
  /**
   * Open the Host's own directory picker — the same gesture the frame's empty
   * state offers under "Choose workspace".
   * @returns the chosen path, or null when the user cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * Register a directory as a project, so a terminal started in it is
   * accounted for like any other conversation and its row appears where the
   * user expects it.
   * @param path - the directory the picker returned.
   * @returns its canonical path, as the Host recorded it.
   */
  registerProject(path: string): Promise<string>
}

/** Derives the terminal's scope and follows Code conversations into the column. */
export class CodeModeController {
  /** What the column's socket is built from; `undefined` while there is nowhere to run. */
  readonly scope: SnapshotStore<Scope | undefined> = createSnapshotStore<Scope | undefined>(undefined)

  /**
   * What the column is SHOWING, for every surface beside it — the sidebar's
   * cursor, a file tree, a panel.
   *
   * A second store rather than the scope itself, and the difference is one
   * field. The scope's `sessionId` is the WEB conversation the socket belongs
   * to: it rides the socket URL as `session`, so it is the thing that must not
   * move if the terminal is to stay up. The conversation ON SCREEN is the Code
   * one the terminal drives, and the two are the same id only some of the time
   * — clicking a Code row pins it, New Session mints it, and pressing Code from
   * a Work conversation leaves the scope naming that conversation until the
   * host says which terminal it attached.
   *
   * Publishing the scope here instead is what left the sidebar's cursor on a
   * conversation nobody was looking at: `sessionModes.column` was answering
   * with the socket's conversation, which is the one BEHIND the terminal.
   */
  readonly column: SnapshotStore<ColumnScope | undefined>
    = createSnapshotStore<ColumnScope | undefined>(undefined)

  /**
   * Whether pressing Code would go anywhere: a terminal to show, a project to
   * start one in, or a Host that can still be asked where.
   *
   * A store of its own rather than `scope !== undefined`, because those are two
   * different questions and only one of them is about a conversation. What Code
   * SHOWS is derived from the conversation on screen, and a page that has never
   * opened one derives nothing — which is precisely the fresh install this mode
   * used to be permanently grey in.
   */
  readonly enterable: SnapshotStore<boolean> = createSnapshotStore<boolean>(true)

  /**
   * Whether the Host can still be asked where a terminal should run.
   *
   * Optimistic, and downgraded by evidence rather than by a probe: the picker
   * seam has two backends and only the native one answers
   * {@link CodeModeDeps.pickDirectory} — a remote or headless Host drives an
   * in-app browser instead, which is ui-workspace's own component and not
   * something a contributed mode can open. There is no way to ask which is
   * mounted, so the first press that finds out is what tells this segment to
   * stop offering the cold start and say what is missing instead.
   */
  private askable = true

  /**
   * The Code session each directory's terminal is currently driving, as the
   * host reported it on the socket.
   *
   * The session list cannot answer this for a terminal that has not been
   * typed into: nothing is persisted until the first turn, so a freshly minted
   * Code session is invisible to every list for as long as it stays empty.
   * Without this the surface would ask for "a new conversation" again on the
   * next mode switch and strand the one it just started.
   */
  private readonly attached = new Map<string, string>()

  /**
   * A conversation this surface started itself, held above the derived scope
   * until it becomes real or the user goes somewhere else.
   *
   * New Session in Code mode has nothing to derive from: the conversation it
   * asks for does not exist anywhere yet — not in the session list, not on
   * disk, not in the host's terminal table — and will not until its first turn
   * is persisted. So the id is minted here and pinned, which is also what makes
   * the request idempotent: every reconnect, remount and resize while the pin
   * stands asks for the same conversation instead of starting another one.
   */
  private pinned: Scope | undefined

  /** The selection the last recompute saw, so entering follows a CHANGE. */
  private lastCurrent: SessionId | undefined

  /** Accounted Code sessions already asked for, so one miss triggers one pull. */
  private readonly refreshed = new Set<string>()

  private started = false

  /** @param deps - see {@link CodeModeDeps}. */
  constructor(private readonly deps: CodeModeDeps) {}

  /**
   * Begin deriving from the live lists.
   * @returns the disposer, unsubscribing from both.
   */
  start(): () => void {
    const recompute = (): void => { this.recompute() }
    const stops = [this.deps.sessions.subscribe(recompute), this.deps.workspaces.subscribe(recompute)]
    this.started = true
    recompute()
    return () => {
      this.started = false
      for (const stop of stops) stop()
    }
  }

  /**
   * Record which Code session the host attached this surface to.
   * @param cwd - the directory the terminal runs in.
   * @param codeSessionId - the conversation it drives.
   */
  noteAttached(cwd: string, codeSessionId: string): void {
    if (this.attached.get(cwd) === codeSessionId) return
    this.attached.set(cwd, codeSessionId)
    this.recompute()
  }

  /**
   * Show one Code conversation — what clicking its row means — WITHOUT
   * handing it to the web runtime.
   *
   * That last part is the whole method. Making a conversation the runtime's
   * current one is what makes this host resume it: the surfaces that follow a
   * selection ask for its commands and its models, and both of those resolve
   * an agent, which publishes a live session on a log a terminal in another
   * process is appending to. Two live copies of one conversation write
   * interleaved sequence numbers into one file, and a log with a repeated seq
   * is a log the reader refuses — the conversation stops opening at all.
   *
   * So a Code conversation is shown the way a terminal is: pinned here, drawn
   * in the column, and never selected. What that used to cost was the
   * sidebar's highlight — it follows the SELECTION, so it stayed on whatever
   * web conversation was open behind the terminal — which is why this
   * controller publishes {@link CodeModeController.column} beside the scope
   * and the mode system moves the cursor off it.
   * @param codeSessionId - the conversation to show.
   * @param snapshot - the session list to read from; defaults to the live one.
   * @returns true when it could be shown; false when nothing knows its
   * directory, which leaves the caller to do whatever it would have done.
   */
  showConversation(
    codeSessionId: string,
    snapshot: SessionListState = this.deps.sessions.getSnapshot(),
  ): boolean {
    const cwd = this.deps.workspaces.getSnapshot().items
      .find(item => item.sessionIds.includes(codeSessionId as SessionId))?.path
      ?? snapshot.byId[codeSessionId as SessionId]?.cwd
    if (cwd === undefined || cwd === '') return false
    this.pinned = { sessionId: codeSessionId, cwd, codeSessionId }
    this.publishScope(this.pinned)
    this.settleEnterable()
    this.deps.enterCode()
    return true
  }

  /**
   * The Code conversation a directory's terminal is driving, as the host
   * reported it on the socket.
   *
   * The surface reports what happens in a terminal against its DIRECTORY (the
   * pairing it opened its socket for); anything that has to name the
   * conversation asks here, because this map is where the host's answer landed.
   * @param cwd - the directory the terminal runs in.
   * @returns the conversation it drives, or undefined before the host said.
   */
  codeSessionIn(cwd: string): string | undefined {
    return this.attached.get(cwd)
  }

  /**
   * Make sure there is a terminal to show — what PRESSING Code has to mean on a
   * page where nothing is open.
   *
   * The conversation is minted here rather than derived, and on the press rather
   * than in {@link CodeModeController.recompute}, which is the whole point:
   * deriving must stay free of consequences, so a page nobody pressed Code on
   * starts no terminal, while a page where somebody did gets one in the project
   * they are already looking at. Nothing is minted when there is something to
   * show — the ordinary case, and pressing Code then is a change of column and
   * nothing else.
   * @returns true when there is something to show; false when no project is
   * registered anywhere, which is the cold start — see
   * {@link CodeModeController.chooseProject}, not a refusal.
   */
  ensureScope(): boolean {
    if (this.scope.getSnapshot() !== undefined) return true
    const workspaceId = this.defaultWorkspace()
    if (workspaceId === undefined) return false
    return this.startNewConversation(workspaceId)
  }

  /**
   * Ask where the terminal should run, and take the column once there is an
   * answer — the COLD START, and the only thing pressing Code can honestly mean
   * on a page with no project registered anywhere.
   *
   * The Host's own directory picker, because that is already the gesture this
   * screen asks for: a harness with no project shows "Choose workspace" and
   * nothing else, and a mode that greyed itself out instead would leave the
   * person to discover that other button before this one would work. Registering
   * the directory afterwards is what makes the answer stick — the project joins
   * the sidebar, and the terminal is accounted under it like any conversation.
   *
   * Cancelling leaves the column exactly where it was — nothing was chosen, so
   * nothing changes. A Host with no picker THIS side can open is the other
   * outcome, and the one that has to be remembered: see
   * {@link CodeModeController.askable}.
   */
  async chooseProject(): Promise<void> {
    let picked: string | null
    try {
      picked = await this.deps.pickDirectory()
    } catch {
      // The Host has no picker THIS side can open — the browse backend, whose
      // in-app browser belongs to ui-workspace. Stop offering the cold start
      // and let the segment say what is missing, rather than leaving a press
      // that does nothing.
      this.askable = false
      this.settleEnterable()
      return
    }
    if (picked === null || picked === '') return
    let cwd: string
    try {
      // The Host's canon rather than the picker's string: a workspace is keyed
      // on the resolved path, and a terminal started on the other one would be
      // accounted under a project the sidebar shows separately.
      cwd = await this.deps.registerProject(picked)
    } catch {
      // A directory the Host refused to register. The picker still works, so
      // this is one failed answer rather than a mode that cannot be entered.
      return
    }
    if (this.startIn(cwd)) this.deps.enterCode()
  }

  /**
   * Start another Code conversation — New Session, pressed while this mode
   * holds the column.
   *
   * The conversation is named here rather than asked for, because a name is
   * the only way to say "a new one" twice and mean the same one: the socket
   * reconnects, the column remounts, and a request the host answered by
   * minting would start a second terminal each time. Naming it also keeps the
   * whole feature inside the rule this plugin already lives by — a Code
   * conversation IS its id.
   *
   * Where it runs: the project the request named, else the directory the
   * terminal on screen is already in, which is what the sidebar's own button
   * means by "new session" while a terminal is what the user is looking at.
   * @param workspaceId - the project the request named, when it named one.
   * @returns true when a conversation was started; false leaves the request to
   * the frame, which is the right answer when there is no directory to run in.
   */
  startNewConversation(workspaceId?: string): boolean {
    const cwd = workspaceId === undefined
      ? this.scope.getSnapshot()?.cwd
      : this.deps.workspaces.getSnapshot().items.find(item => item.workspaceId === workspaceId)?.path
    return this.startIn(cwd)
  }

  /**
   * Start a Code conversation in one directory — the single writer of a minted
   * scope, shared by New Session and by the two presses that have to make the
   * thing they are switching to.
   * @param cwd - the directory the terminal runs in, when one is known.
   * @returns true when a conversation was started.
   */
  private startIn(cwd: string | undefined): boolean {
    if (cwd === undefined || cwd === '') return false
    const codeSessionId = mintCodeSessionId()
    this.pinned = { sessionId: codeSessionId, cwd, codeSessionId, fresh: true }
    // The pinned id is the socket's `session` too, and deliberately: the host
    // reads the directory off the session store first, so naming the
    // conversation the user is LEAVING would start the new terminal in that
    // one's directory whenever the two differ.
    this.publishScope(this.pinned)
    this.settleEnterable()
    return true
  }

  /**
   * Publish one scope, and what the column is showing with it — the single
   * writer of both stores, so the socket's conversation and the conversation on
   * screen can never be derived from different moments.
   *
   * The terminal's conversation when the host has named one, and the socket's
   * otherwise: the window between pressing Code and the host answering is the
   * only time this mode cannot say better, and reporting nothing then would
   * take the cursor off the sidebar instead of leaving it where it was.
   * @param next - the scope, or undefined when there is nowhere to run.
   */
  private publishScope(next: Scope | undefined): void {
    this.scope.set(next)
    const shown = next === undefined
      ? undefined
      : { sessionId: next.codeSessionId ?? next.sessionId, cwd: next.cwd }
    const previous = this.column.getSnapshot()
    // Guarded rather than set through: every surface beside the column watches
    // this, and the scope republishes for facts none of them can see (`fresh`
    // settling, a resume offer changing).
    if (previous?.sessionId === shown?.sessionId && previous?.cwd === shown?.cwd) return
    this.column.set(shown)
  }

  /**
   * The project a terminal runs in when no conversation names one.
   *
   * The runtime's own "most recently active" answer first — the project the
   * user was last in, which is what pressing Code with nothing open should come
   * back to — and the top of the workspace list under it, because that is the
   * sidebar's first group and so where the user would have clicked anyway.
   * @returns its workspace id, or undefined when no project is registered.
   */
  private defaultWorkspace(): string | undefined {
    const { items, recentWorkspaceId } = this.deps.workspaces.getSnapshot()
    const usable = items.filter(item => item.path !== '')
    return usable.find(item => item.workspaceId === recentWorkspaceId)?.workspaceId
      ?? usable[0]?.workspaceId
  }

  /** Settle whether pressing Code would go anywhere; see {@link CodeModeController.enterable}. */
  private settleEnterable(): void {
    this.enterable.set(
      this.scope.getSnapshot() !== undefined
      || this.defaultWorkspace() !== undefined
      || this.askable,
    )
  }

  /** Re-derive the scope, and follow a newly opened Code conversation. */
  private recompute(): void {
    const sessions = this.deps.sessions.getSnapshot()
    const current = sessions.current
    // On the CHANGE, never on every publish: a user who deliberately pressed
    // Work while a Code conversation is open is reading its transcript in the
    // web view, and re-asserting the column would take that away on the next
    // list update.
    //
    // And on a change TO something: the selection going briefly absent — a
    // baseline refresh, a workspace reconnecting — is not the user going
    // anywhere, and reading it as one would both re-enter the column when the
    // same conversation came back and strand a conversation this surface had
    // just started.
    const moved = current !== undefined && current !== this.lastCurrent
    if (current !== undefined) this.lastCurrent = current
    // Going somewhere ends a conversation this surface pinned: the selection
    // is the authority again, and it now says something else.
    if (moved) this.pinned = undefined

    const next = this.pinned
      ?? this.readScope(sessions, this.deps.workspaces.getSnapshot(), current)
    const previous = this.scope.getSnapshot()
    if (
      previous?.sessionId !== next?.sessionId
      || previous?.cwd !== next?.cwd
      || previous?.codeSessionId !== next?.codeSessionId
      // A conversation that became real stops being freshly minted, and the
      // scope says so — the socket is keyed on the other three, so this is a
      // fact settling rather than a terminal restarting.
      || previous?.fresh !== next?.fresh
    ) {
      this.publishScope(next)
    }
    // After the scope, and unconditionally: a project registered (or the last
    // one removed) moves this without moving the scope at all.
    this.settleEnterable()

    this.pullMissingRows()

    // A Code conversation that is nevertheless SELECTED: this build never
    // selects one (see showConversation), so it came from a build that did and
    // the runtime restored it on load. Show it the safe way and hand the
    // selection back, before the surfaces that follow a selection ask this
    // host to resume a conversation a terminal owns.
    if (current !== undefined && isCodeSessionId(current) && this.started) {
      this.showConversation(current, sessions)
      this.deps.clearSelection()
    }
  }

  /**
   * The scope for one selection.
   * @param sessions - the session list snapshot.
   * @param workspaces - the workspace list snapshot.
   * @param current - the selected conversation, when there is one.
   * @returns the scope, or undefined when no directory is known.
   */
  private readScope(
    sessions: SessionListState,
    workspaces: WorkspaceListState,
    current: SessionId | undefined,
  ): Scope | undefined {
    if (current === undefined) return undefined
    const summary = sessions.byId[current]
    // The workspace account is the authority on where a conversation belongs;
    // the session's own header covers one that is not grouped yet.
    const cwd = workspaces.items.find(item => item.sessionIds.includes(current))?.path
      ?? summary?.cwd
    // A conversation with no directory has nowhere to start a terminal.
    if (cwd === undefined || cwd === '') return undefined
    if (isCodeSessionId(current)) return { sessionId: current, cwd, codeSessionId: current }
    // Only what this page was told: the host decides for a socket that names
    // nothing, and it decides from its own live terminals.
    const remembered = this.attached.get(cwd)
    if (remembered !== undefined) return { sessionId: current, cwd, codeSessionId: remembered }
    // Nothing named, so offer the project's most recent conversation. The host
    // takes it only if it has no terminal running here — see resolveCodeSession
    // — which is what makes pressing Code after a restart come back to the work
    // rather than to an empty prompt.
    const offered = this.recentIn(cwd, sessions, workspaces)
    return {
      sessionId: current,
      cwd,
      ...offered === undefined ? {} : { resumeSessionId: offered },
    }
  }

  /**
   * The most recent Code conversation this project has, as the lists have it.
   *
   * Recency is the session list's own `updatedAt`, which is what the sidebar
   * orders by — so "the most recent" here means the row a person would have
   * clicked at the top of that project's group.
   *
   * Blank conversations are skipped: nothing was ever said in one, so there is
   * nothing to come back TO, and one is routinely left behind by a terminal
   * somebody opened and walked away from. Membership is read from the
   * workspace account first and the session's own directory second, because a
   * conversation whose account never landed (no workspace registered at that
   * path) is still that project's.
   * @param cwd - the directory a terminal would run in.
   * @param sessions - the session list snapshot.
   * @param workspaces - the workspace list snapshot.
   * @returns the conversation to offer, or undefined when the project has none.
   */
  private recentIn(
    cwd: string,
    sessions: SessionListState,
    workspaces: WorkspaceListState,
  ): string | undefined {
    const grouped = new Set<string>(workspaces.items.find(item => item.path === cwd)?.sessionIds ?? [])
    let best: { id: string; at: number } | undefined
    for (const id of sessions.ids) {
      if (!isCodeSessionId(id)) continue
      const summary = sessions.byId[id]
      if (summary === undefined || summary.blank === true) continue
      if (!grouped.has(id) && summary.cwd !== cwd) continue
      const at = summary.updatedAt
      if (best === undefined || at > best.at) best = { id, at }
    }
    return best?.id
  }

  /**
   * Ask for a fresh session baseline when a workspace account names a Code
   * conversation the list has never seen — the host attached it after this
   * page's baseline was pulled, and the row stays invisible until a summary
   * for it arrives. Once per id: a pull that does not produce the summary
   * (an archived session, a log removed underneath) must not become a loop.
   */
  private pullMissingRows(): void {
    const sessions = this.deps.sessions.getSnapshot()
    for (const workspace of this.deps.workspaces.getSnapshot().items) {
      for (const sessionId of workspace.sessionIds) {
        if (!isCodeSessionId(sessionId) || this.refreshed.has(sessionId)) continue
        if (sessions.byId[sessionId] !== undefined) continue
        this.refreshed.add(sessionId)
        this.deps.refreshSessions()
      }
    }
  }
}
