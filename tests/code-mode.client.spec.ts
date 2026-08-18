// @vitest-environment jsdom
// Which terminal Code mode shows, and when a Code conversation takes the column.
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { CodeModeController } from '../src/client/code-mode.ts'
import { isCodeSessionId } from '../src/code-session.ts'

/** One session list row, with only the fields this controller reads. */
function summary(id: string, cwd: string | undefined, updatedAt = 0) {
  return {
    id, sessionId: id, cwd, updatedAt, running: false, blank: false, displayTitle: id,
  // Indexed by its own key type rather than `string`: the published harness
  // keys this map by a branded SessionId, which a bare `string` index misses.
  } as unknown as SessionListState['byId'][keyof SessionListState['byId']]
}

/** A session list snapshot. */
function sessionList(
  rows: ReturnType<typeof summary>[],
  current?: string,
): SessionListState {
  const byId: Record<string, ReturnType<typeof summary>> = {}
  for (const row of rows) byId[(row as unknown as { id: string }).id] = row
  return {
    ids: rows.map(row => (row as unknown as { id: string }).id),
    byId,
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as unknown as SessionListState
}

/**
 * A workspace list snapshot.
 * @param items - the projects, in the sidebar's own display order.
 * @param recent - the runtime's most-recently-active project, when it has one.
 * @returns the snapshot.
 */
function workspaceList(
  items: { path: string; sessionIds: string[] }[],
  recent?: string,
): WorkspaceListState {
  return {
    items: items.map((item, index) => ({
      workspaceId: `w${String(index)}`,
      path: item.path,
      title: item.path,
      sessionIds: item.sessionIds,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: recent,
  } as unknown as WorkspaceListState
}

/** The controller over stores a spec can push new snapshots into. */
function bench(options: {
  sessions?: SessionListState
  workspaces?: WorkspaceListState
  /** What the Host's directory picker answers; null is the cancelled dialog. */
  picked?: string | null
  /** A picker the Host could not open, or a directory it refused to register. */
  pickerFails?: 'pick' | 'register'
  /**
   * Conversations that live in no project — a chat, as the mode registry
   * reports it. Everything else is in one, which is what a conversation is.
   */
  outsideProjects?: string[]
} = {}) {
  const sessions = createSnapshotStore(options.sessions ?? sessionList([]))
  const workspaces = createSnapshotStore(options.workspaces ?? workspaceList([]))
  const enterCode = vi.fn()
  const refreshSessions = vi.fn()
  // Clearing publishes, the way the runtime's own does — which is what
  // re-enters the controller.
  const clearSelection = vi.fn(() => {
    sessions.set({ ...sessions.getSnapshot(), current: undefined } as SessionListState)
  })
  const pickDirectory = vi.fn(async () => {
    if (options.pickerFails === 'pick') throw new Error('no picker on this Host')
    return options.picked ?? null
  })
  // The Host's canon, which is what a workspace is keyed on — a spec's answer
  // differs from the picked string so a scope built on the wrong one shows.
  const registerProject = vi.fn(async (path: string) => {
    if (options.pickerFails === 'register') throw new Error('not a directory')
    return `${path}/canon`
  })
  const controller = new CodeModeController({
    sessions, workspaces, enterCode, clearSelection, refreshSessions, pickDirectory, registerProject,
    inProject: (sessionId: string) => !(options.outsideProjects ?? []).includes(sessionId),
  })
  const stop = controller.start()
  return {
    controller, sessions, workspaces, enterCode, clearSelection, refreshSessions,
    pickDirectory, registerProject, stop,
  }
}

describe('the terminal scope', () => {
  it('has none while no conversation is open', () => {
    expect(bench().controller.scope.getSnapshot()).toBeUndefined()
  })

  it('has none for a conversation with no directory: there is nowhere to run', () => {
    const b = bench({ sessions: sessionList([summary('session-1', undefined)], 'session-1') })
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
  })

  it('runs in the workspace the conversation is grouped under', () => {
    const b = bench({
      sessions: sessionList([summary('session-1', '/stale')], 'session-1'),
      workspaces: workspaceList([{ path: '/repo', sessionIds: ['session-1'] }]),
    })
    // The account, not the header: the group the row was clicked in is what
    // the person means by "here".
    expect(b.controller.scope.getSnapshot()?.cwd).toBe('/repo')
  })

  it('falls back to the session\'s own directory before it is grouped', () => {
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    expect(b.controller.scope.getSnapshot()?.cwd).toBe('/repo')
  })

  it('resumes the Code conversation that is open', () => {
    const b = bench({
      sessions: sessionList([summary('code-session-a', '/repo')], 'code-session-a'),
    })
    expect(b.controller.scope.getSnapshot()).toEqual({
      sessionId: 'code-session-a',
      cwd: '/repo',
      codeSessionId: 'code-session-a',
    })
  })

  it('offers the project\'s most recent conversation, and names none', () => {
    // Pressing Code should come back to the work rather than to an empty
    // prompt — but the browser only OFFERS: this host's own live terminal
    // outranks it, because a conversation started a moment ago has nothing on
    // disk to be "most recent" (see chooseCodeSession).
    const b = bench({
      sessions: sessionList([
        summary('session-1', '/repo'),
        summary('code-session-old', '/repo', 100),
        summary('code-session-new', '/repo', 200),
      ], 'session-1'),
    })
    const scope = b.controller.scope.getSnapshot()
    expect(scope?.codeSessionId).toBeUndefined()
    expect(scope?.resumeSessionId).toBe('code-session-new')
  })

  it('offers nothing it cannot come back to', () => {
    // A blank conversation is one a terminal opened and nobody typed into;
    // there is nothing in it to return to, and a project collects them.
    const blank = { ...summary('code-session-blank', '/repo', 900), blank: true } as ReturnType<typeof summary>
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo'), summary('code-session-said', '/repo', 100), blank], 'session-1'),
    })
    expect(b.controller.scope.getSnapshot()?.resumeSessionId).toBe('code-session-said')
  })

  it('offers only this project\'s conversations', () => {
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo'), summary('code-session-elsewhere', '/other', 900)], 'session-1'),
    })
    expect(b.controller.scope.getSnapshot()?.resumeSessionId).toBeUndefined()
  })

  it('reads membership from the workspace account as well as the header', () => {
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo'), summary('code-session-a', '/stale', 100)], 'session-1'),
      workspaces: workspaceList([{ path: '/repo', sessionIds: ['session-1', 'code-session-a'] }]),
    })
    expect(b.controller.scope.getSnapshot()?.resumeSessionId).toBe('code-session-a')
  })

  it('stops offering once the host has said which terminal this is', () => {
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo'), summary('code-session-old', '/repo', 100)], 'session-1'),
    })
    b.controller.noteAttached('/repo', 'code-session-live')
    const scope = b.controller.scope.getSnapshot()
    expect(scope?.codeSessionId).toBe('code-session-live')
    expect(scope?.resumeSessionId).toBeUndefined()
  })

  it('leaves the answer to the host when a project has nothing to come back to', () => {
    // No conversation is NAMED here whatever the lists hold: naming one is
    // saying "this exact terminal", and only a click or the host's own answer
    // may do that.
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    const scope = b.controller.scope.getSnapshot()
    expect(scope?.codeSessionId).toBeUndefined()
    expect(scope?.resumeSessionId).toBeUndefined()
  })

  it('holds on to a terminal nothing has been said in yet', () => {
    // The session is not persisted until its first turn, so no list can name
    // it; without the host's report, the next mode switch would start a second
    // terminal beside the one already running.
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    b.controller.noteAttached('/repo', 'code-session-fresh')
    expect(b.controller.scope.getSnapshot()?.codeSessionId).toBe('code-session-fresh')
  })

  it('answers which conversation a directory\'s terminal drives', () => {
    // Everything the surface reports about a terminal is keyed by its
    // directory (the pairing it opened its socket for); naming the
    // conversation is the host's answer, and this is where it landed.
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    expect(b.controller.codeSessionIn('/repo')).toBeUndefined()
    b.controller.noteAttached('/repo', 'code-session-a')
    expect(b.controller.codeSessionIn('/repo')).toBe('code-session-a')
    expect(b.controller.codeSessionIn('/elsewhere')).toBeUndefined()
  })

  it('keeps each directory\'s terminal apart', () => {
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo'), summary('session-2', '/other')], 'session-1'),
    })
    b.controller.noteAttached('/repo', 'code-session-a')
    b.controller.noteAttached('/other', 'code-session-b')
    expect(b.controller.scope.getSnapshot()?.codeSessionId).toBe('code-session-a')
    b.sessions.set(sessionList(
      [summary('session-1', '/repo'), summary('session-2', '/other')],
      'session-2',
    ))
    expect(b.controller.scope.getSnapshot()?.codeSessionId).toBe('code-session-b')
  })
})

describe('what the column is showing', () => {
  // The scope names the conversation the SOCKET belongs to; this names the one
  // the terminal is driving. Every surface beside the column reads the second,
  // the sidebar's cursor included, and publishing the first is what used to
  // leave that cursor on the conversation behind the terminal.
  it('shows nothing while there is nowhere to run', () => {
    expect(bench().controller.column.getSnapshot()).toBeUndefined()
  })

  it('shows the Code conversation a row was clicked on', () => {
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo'), summary('code-session-a', '/repo')], 'session-1'),
    })
    expect(b.controller.showConversation('code-session-a')).toBe(true)
    expect(b.controller.column.getSnapshot()).toEqual({ sessionId: 'code-session-a', cwd: '/repo' })
  })

  it('shows the conversation New Session minted, before any list has heard of it', () => {
    const b = bench({ workspaces: workspaceList([{ path: '/repo', sessionIds: [] }]) })
    expect(b.controller.startNewConversation('w0')).toBe(true)
    const shown = b.controller.column.getSnapshot()
    expect(shown?.cwd).toBe('/repo')
    expect(isCodeSessionId(shown?.sessionId ?? '')).toBe(true)
    expect(shown?.sessionId).toBe(b.controller.scope.getSnapshot()?.codeSessionId)
  })

  it('shows the terminal the host attached, not the conversation the socket names', () => {
    // Pressing Code from a Work conversation: the socket belongs to that
    // conversation and the terminal drives another one entirely.
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    expect(b.controller.column.getSnapshot()).toEqual({ sessionId: 'session-1', cwd: '/repo' })
    b.controller.noteAttached('/repo', 'code-session-live')
    expect(b.controller.column.getSnapshot()).toEqual({ sessionId: 'code-session-live', cwd: '/repo' })
    // And the socket's own conversation has not moved, or the terminal would
    // have been restarted under the user.
    expect(b.controller.scope.getSnapshot()?.sessionId).toBe('session-1')
  })

  it('publishes only when the conversation or its directory moved', () => {
    // The scope republishes for facts no surface beside the column can see —
    // `fresh` settling, a resume offer changing — and every one of those would
    // otherwise repaint the sidebar.
    const b = bench({ workspaces: workspaceList([{ path: '/repo', sessionIds: [] }]) })
    b.controller.startNewConversation('w0')
    const seen: unknown[] = []
    b.controller.column.subscribe(() => { seen.push(b.controller.column.getSnapshot()) })
    b.controller.noteAttached('/repo', b.controller.scope.getSnapshot()?.codeSessionId ?? '')
    expect(seen).toEqual([])
  })

  it('stops showing anything once there is nowhere to run', () => {
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo'), summary('session-2', undefined)], 'session-1'),
    })
    expect(b.controller.column.getSnapshot()?.sessionId).toBe('session-1')
    b.sessions.set(sessionList([summary('session-1', '/repo'), summary('session-2', undefined)], 'session-2'))
    expect(b.controller.column.getSnapshot()).toBeUndefined()
  })
})

describe('a conversation that is in no project', () => {
  // A chat: its directory is a store the mode that owns it keeps, and nobody
  // works there. Deriving from it opened a terminal inside the folder chats
  // are filed in — so Code comes back to where it last was instead, which is
  // the rule Work follows from a chat too.
  it('names no directory of its own, however plainly it has one', () => {
    const b = bench({
      sessions: sessionList([summary('chat-1', '/home/.dsh/sessions/chat')], 'chat-1'),
      outsideProjects: ['chat-1'],
    })
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
  })

  it('comes back to the terminal this page already has', () => {
    const b = bench({
      sessions: sessionList([
        summary('session-1', '/repo'), summary('chat-1', '/chat-store'),
      ], 'session-1'),
      outsideProjects: ['chat-1'],
    })
    b.controller.noteAttached('/repo', 'code-session-live')
    b.sessions.set(sessionList([
      summary('session-1', '/repo'), summary('chat-1', '/chat-store'),
    ], 'chat-1'))
    expect(b.controller.scope.getSnapshot()).toEqual({
      sessionId: 'code-session-live',
      cwd: '/repo',
      codeSessionId: 'code-session-live',
    })
  })

  it('offers that project\'s most recent conversation when no terminal is up', () => {
    const b = bench({
      sessions: sessionList([
        summary('session-1', '/repo'),
        summary('code-session-old', '/repo', 100),
        summary('code-session-new', '/repo', 200),
        summary('chat-1', '/chat-store'),
      ], 'session-1'),
      outsideProjects: ['chat-1'],
    })
    b.sessions.set(sessionList([
      summary('session-1', '/repo'),
      summary('code-session-old', '/repo', 100),
      summary('code-session-new', '/repo', 200),
      summary('chat-1', '/chat-store'),
    ], 'chat-1'))
    const scope = b.controller.scope.getSnapshot()
    expect(scope?.cwd).toBe('/repo')
    // Offered, never named: the conversation may be held by another process,
    // and the host's own live table outranks a browser's guess.
    expect(scope?.resumeSessionId).toBe('code-session-new')
    expect(scope?.codeSessionId).toBeUndefined()
    // And the socket names the offer rather than the chat, or the host would
    // resolve the chat's own directory and put the terminal back in it.
    expect(scope?.sessionId).toBe('code-session-new')
  })

  it('starts nowhere at all before Code has been anywhere', () => {
    const b = bench({
      sessions: sessionList([summary('chat-1', '/chat-store')], 'chat-1'),
      outsideProjects: ['chat-1'],
    })
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
  })

  it('is not the project a press starts a terminal in either', () => {
    // The runtime's "most recently active" workspace is the chat store for
    // somebody who has been chatting, and the cold start used to take it.
    const b = bench({
      sessions: sessionList([summary('chat-1', '/chat-store')], 'chat-1'),
      workspaces: workspaceList([
        { path: '/chat-store', sessionIds: ['chat-1'] },
        { path: '/repo', sessionIds: [] },
      ], 'w0'),
      outsideProjects: ['chat-1'],
    })
    expect(b.controller.ensureScope()).toBe(true)
    expect(b.controller.scope.getSnapshot()?.cwd).toBe('/repo')
  })
})

describe('pressing Code with nothing open', () => {
  it('starts a terminal in the project, deriving one having been impossible', () => {
    // The fresh page: nothing is selected, so the scope has nothing to derive
    // from — but the project is right there in the sidebar, and that is all a
    // terminal ever needed.
    const b = bench({ workspaces: workspaceList([{ path: '/repo', sessionIds: [] }]) })
    expect(b.controller.scope.getSnapshot()).toBeUndefined()

    expect(b.controller.ensureScope()).toBe(true)
    const scope = b.controller.scope.getSnapshot()
    expect(scope?.cwd).toBe('/repo')
    expect(isCodeSessionId(scope?.codeSessionId ?? '')).toBe(true)
    // Minted a moment ago rather than resumed, which is what tells the host
    // nobody else can be holding it.
    expect(scope?.fresh).toBe(true)
  })

  it('mints nothing until it is actually pressed', () => {
    // Deriving stays free of consequences: publishing the lists over and over
    // starts no terminal, so a page nobody pressed Code on holds no
    // conversation id.
    const b = bench({ workspaces: workspaceList([{ path: '/repo', sessionIds: [] }]) })
    b.workspaces.set(workspaceList([{ path: '/repo', sessionIds: [] }]))
    b.sessions.set(sessionList([]))
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
  })

  it('shows what is already there rather than starting another', () => {
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    const before = b.controller.scope.getSnapshot()
    expect(b.controller.ensureScope()).toBe(true)
    expect(b.controller.scope.getSnapshot()).toBe(before)
  })

  it('starts in the project the runtime itself would land in', () => {
    // `recentWorkspaceId` is the runtime's own answer to "where were you", and
    // the one it uses to pick the conversation to restore — so a terminal
    // started from nothing lands in the same place the rest of the app would.
    const b = bench({
      workspaces: workspaceList([{ path: '/repo', sessionIds: [] }, { path: '/other', sessionIds: [] }], 'w1'),
    })
    expect(b.controller.ensureScope()).toBe(true)
    expect(b.controller.scope.getSnapshot()?.cwd).toBe('/other')
  })

  it('falls back to the sidebar\'s top group when the runtime names none', () => {
    const b = bench({
      workspaces: workspaceList([{ path: '/repo', sessionIds: [] }, { path: '/other', sessionIds: [] }]),
    })
    expect(b.controller.ensureScope()).toBe(true)
    expect(b.controller.scope.getSnapshot()?.cwd).toBe('/repo')
  })

  it('has nothing to derive where no project is registered at all', () => {
    const b = bench()
    expect(b.controller.ensureScope()).toBe(false)
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
  })
})

describe('whether pressing Code would go anywhere', () => {
  it('is offered on a page with nothing open, which is where it used to be dead', () => {
    const b = bench({ workspaces: workspaceList([{ path: '/repo', sessionIds: [] }]) })
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
    expect(b.controller.enterable.getSnapshot()).toBe(true)
  })

  it('is offered with no project either, because the Host can still be asked', () => {
    expect(bench().controller.enterable.getSnapshot()).toBe(true)
  })

  it('stops being offered once the Host proves it cannot be asked', async () => {
    // The browse backend: the in-app directory browser belongs to ui-workspace,
    // and a contributed mode has no way to open it. One press finds out, and
    // the segment says what is missing from then on instead of doing nothing.
    const b = bench({ pickerFails: 'pick' })
    await b.controller.chooseProject()
    expect(b.controller.enterable.getSnapshot()).toBe(false)
  })

  it('comes back the moment a project is registered', async () => {
    const b = bench({ pickerFails: 'pick' })
    await b.controller.chooseProject()
    expect(b.controller.enterable.getSnapshot()).toBe(false)
    b.workspaces.set(workspaceList([{ path: '/repo', sessionIds: [] }]))
    expect(b.controller.enterable.getSnapshot()).toBe(true)
  })

  it('survives a cancelled picker: cancelling is an answer, not a broken Host', async () => {
    const b = bench({ picked: null })
    await b.controller.chooseProject()
    expect(b.controller.enterable.getSnapshot()).toBe(true)
  })

  it('survives a directory the Host would not register', async () => {
    const b = bench({ picked: '/repo', pickerFails: 'register' })
    await b.controller.chooseProject()
    expect(b.controller.enterable.getSnapshot()).toBe(true)
  })
})

describe('the cold start: pressing Code with no project anywhere', () => {
  it('asks the Host where, registers the answer, and takes the column', async () => {
    // The fresh install this mode used to be permanently grey in. There is
    // nowhere to run and exactly one gesture that changes that — the same one
    // the frame's own empty state offers.
    const b = bench({ picked: '/repo' })
    await b.controller.chooseProject()
    expect(b.pickDirectory).toHaveBeenCalledTimes(1)
    expect(b.registerProject).toHaveBeenCalledWith('/repo')
    // The Host's canon, not the picked string: a workspace is keyed on the
    // resolved path, and a terminal on the other one is accounted elsewhere.
    expect(b.controller.scope.getSnapshot()?.cwd).toBe('/repo/canon')
    expect(b.enterCode).toHaveBeenCalledTimes(1)
  })

  it('leaves the column alone when the picker is cancelled', async () => {
    const b = bench({ picked: null })
    await b.controller.chooseProject()
    expect(b.registerProject).not.toHaveBeenCalled()
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
    expect(b.enterCode).not.toHaveBeenCalled()
  })

  it('leaves it alone when the Host has no picker to open', async () => {
    const b = bench({ pickerFails: 'pick' })
    await expect(b.controller.chooseProject()).resolves.toBeUndefined()
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
    expect(b.enterCode).not.toHaveBeenCalled()
  })

  it('leaves it alone when the directory cannot be registered', async () => {
    const b = bench({ picked: '/repo', pickerFails: 'register' })
    await expect(b.controller.chooseProject()).resolves.toBeUndefined()
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
    expect(b.enterCode).not.toHaveBeenCalled()
  })
})

describe('New Session, pressed in Code mode', () => {
  it('starts another conversation where the terminal on screen is running', () => {
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    expect(b.controller.startNewConversation()).toBe(true)
    const scope = b.controller.scope.getSnapshot()
    expect(scope?.cwd).toBe('/repo')
    expect(isCodeSessionId(scope?.codeSessionId ?? '')).toBe(true)
    // Minted, not resumed: the host may hand this terminal to a later socket
    // that names nothing, because it is this directory's terminal from now on.
    expect(scope?.fresh).toBe(true)
    // The conversation names itself on the wire, so the host reads the
    // directory from the request rather than from the session being left.
    expect(scope?.sessionId).toBe(scope?.codeSessionId)
  })

  it('starts it in the project the request named', () => {
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo')], 'session-1'),
      workspaces: workspaceList([{ path: '/repo', sessionIds: ['session-1'] }, { path: '/other', sessionIds: [] }]),
    })
    expect(b.controller.startNewConversation('w1')).toBe(true)
    expect(b.controller.scope.getSnapshot()?.cwd).toBe('/other')
  })

  it('declines when there is no directory to run in', () => {
    // Answered rather than guessed: declining hands the request back to the
    // frame, which shows a conversation — better than a terminal somewhere
    // nobody asked for.
    const b = bench()
    expect(b.controller.startNewConversation()).toBe(false)
    expect(b.controller.scope.getSnapshot()).toBeUndefined()
    expect(b.controller.startNewConversation('nope')).toBe(false)
  })

  it('asks for the same conversation on every later publish', () => {
    // The socket reconnects and the column remounts; a request the host
    // answered by minting would start a terminal each time.
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    b.controller.startNewConversation()
    const first = b.controller.scope.getSnapshot()?.codeSessionId
    b.sessions.set(sessionList([summary('session-1', '/repo', 9)], 'session-1'))
    b.controller.noteAttached('/repo', first as string)
    expect(b.controller.scope.getSnapshot()?.codeSessionId).toBe(first)
  })

  it('never hands the conversation to the runtime, however real it becomes', () => {
    // Selecting a Code conversation is what makes this host resume it, and a
    // second live copy on a log its terminal is appending to is how a session
    // log ends up with a repeated seq — the state where it stops loading at
    // all. The row exists; the selection stays where the user left it.
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    b.controller.startNewConversation()
    const started = b.controller.scope.getSnapshot()?.codeSessionId as string
    b.sessions.set(sessionList([summary('session-1', '/repo'), summary(started, '/repo')], 'session-1'))
    expect(b.clearSelection).not.toHaveBeenCalled()
    expect(b.controller.scope.getSnapshot()?.codeSessionId).toBe(started)
  })

  it('holds on while the selection is briefly absent', () => {
    // A baseline refresh (which starting a conversation triggers, to bring its
    // row in) can publish with no selection for a beat. That is not the user
    // going anywhere, and reading it as one would strand the terminal they
    // just asked for.
    const b = bench({ sessions: sessionList([summary('session-1', '/repo')], 'session-1') })
    b.controller.startNewConversation()
    const started = b.controller.scope.getSnapshot()?.codeSessionId
    b.sessions.set(sessionList([summary('session-1', '/repo')], undefined))
    b.sessions.set(sessionList([summary('session-1', '/repo')], 'session-1'))
    expect(b.controller.scope.getSnapshot()?.codeSessionId).toBe(started)
  })

  it('lets go the moment the user opens something else', () => {
    const b = bench({ sessions: sessionList([summary('session-1', '/repo'), summary('session-2', '/other')], 'session-1') })
    b.controller.startNewConversation()
    b.sessions.set(sessionList([summary('session-1', '/repo'), summary('session-2', '/other')], 'session-2'))
    // The selection is the authority again, and it says another conversation.
    expect(b.controller.scope.getSnapshot()).toEqual({ sessionId: 'session-2', cwd: '/other' })
  })
})

/** Let a deferred claim run; anything deferred here rides a microtask. */
const settle = (): Promise<void> => Promise.resolve()

describe('showing a Code conversation', () => {
  it('draws it in the column without letting the runtime select it', () => {
    // The whole rule: a selected conversation is one this host resumes, and a
    // second live copy on a log its terminal is appending to corrupts that log.
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo'), summary('code-session-a', '/repo')], 'session-1'),
    })
    expect(b.controller.showConversation('code-session-a')).toBe(true)
    expect(b.enterCode).toHaveBeenCalledOnce()
    expect(b.controller.scope.getSnapshot()).toEqual({
      sessionId: 'code-session-a',
      cwd: '/repo',
      codeSessionId: 'code-session-a',
    })
    // The selection never moved.
    expect(b.sessions.getSnapshot().current).toBe('session-1')
  })

  it('prefers the workspace it is accounted under to its own header', () => {
    const b = bench({
      sessions: sessionList([summary('code-session-a', '/stale')]),
      workspaces: workspaceList([{ path: '/repo', sessionIds: ['code-session-a'] }]),
    })
    b.controller.showConversation('code-session-a')
    expect(b.controller.scope.getSnapshot()?.cwd).toBe('/repo')
  })

  it('declines one whose directory nothing knows', () => {
    // Nowhere to run a terminal; the caller is left to do what it would have.
    const b = bench()
    expect(b.controller.showConversation('code-session-a')).toBe(false)
    expect(b.enterCode).not.toHaveBeenCalled()
  })

  it('holds it while the user stays put, and lets go when they open something else', () => {
    const b = bench({
      sessions: sessionList([summary('session-1', '/repo'), summary('session-2', '/other'), summary('code-session-a', '/repo')], 'session-1'),
    })
    b.controller.showConversation('code-session-a')
    b.sessions.set(sessionList([summary('session-1', '/repo', 9), summary('session-2', '/other'), summary('code-session-a', '/repo')], 'session-1'))
    expect(b.controller.scope.getSnapshot()?.codeSessionId).toBe('code-session-a')
    b.sessions.set(sessionList([summary('session-1', '/repo'), summary('session-2', '/other')], 'session-2'))
    expect(b.controller.scope.getSnapshot()).toEqual({ sessionId: 'session-2', cwd: '/other' })
  })

  it('takes over one a previous build left selected, and hands the selection back', async () => {
    // Builds before this one selected Code conversations, and the runtime
    // restores its selection on load — which would resume it here, on a log
    // its terminal owns. Show it, then give the selection up.
    const b = bench({ sessions: sessionList([summary('code-session-a', '/repo')], 'code-session-a') })
    await settle()
    expect(b.enterCode).toHaveBeenCalled()
    expect(b.clearSelection).toHaveBeenCalled()
    expect(b.controller.scope.getSnapshot()?.codeSessionId).toBe('code-session-a')
    // And it keeps showing it afterwards: the pin is what the column reads.
    expect(b.sessions.getSnapshot().current).toBeUndefined()
    expect(b.controller.scope.getSnapshot()?.codeSessionId).toBe('code-session-a')
  })

  it('stops following once the plugin unloads', async () => {
    const b = bench()
    b.stop()
    b.sessions.set(sessionList([summary('code-session-a', '/repo')], 'code-session-a'))
    await settle()
    expect(b.enterCode).not.toHaveBeenCalled()
    expect(b.clearSelection).not.toHaveBeenCalled()
  })
})

describe('rows the session list has never seen', () => {
  it('pulls a fresh baseline when a workspace accounts for an unknown Code conversation', () => {
    const b = bench()
    b.workspaces.set(workspaceList([{ path: '/repo', sessionIds: ['code-session-a'] }]))
    expect(b.refreshSessions).toHaveBeenCalledOnce()
  })

  it('pulls once per conversation, never in a loop', () => {
    // The baseline may legitimately not produce the row (archived, log
    // removed); asking again on every publish would be a spin.
    const b = bench()
    b.workspaces.set(workspaceList([{ path: '/repo', sessionIds: ['code-session-a'] }]))
    b.workspaces.set(workspaceList([{ path: '/repo', sessionIds: ['code-session-a'] }, { path: '/x', sessionIds: [] }]))
    expect(b.refreshSessions).toHaveBeenCalledOnce()
  })

  it('leaves the harness\'s own conversations alone', () => {
    const b = bench()
    b.workspaces.set(workspaceList([{ path: '/repo', sessionIds: ['session-unknown'] }]))
    expect(b.refreshSessions).not.toHaveBeenCalled()
  })

  it('says nothing about a Code conversation the list already carries', () => {
    const b = bench({ sessions: sessionList([summary('code-session-a', '/repo')]) })
    b.workspaces.set(workspaceList([{ path: '/repo', sessionIds: ['code-session-a'] }]))
    expect(b.refreshSessions).not.toHaveBeenCalled()
  })
})
