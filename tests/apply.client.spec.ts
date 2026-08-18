// @vitest-environment jsdom
// The browser plugin body: one contributed segment, and the conversation
// column it takes and gives back with that segment's active flag.
import { describe, expect, it } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { ModeSegmentRegistry } from '@omdsh-plugins/omdsh-basemode/src/client/mode-segments.ts'
import { apply, COLUMN_PRIORITY, inject, isCodeSessionId, SEGMENT_ID } from '../src/client/index.ts'
import type { Scope } from '../src/client/api.ts'
import type { CodeColumnInjected } from '../src/client/contract.ts'
import type { ModeSegment } from '../src/client/session-modes.ts'
import { en } from '../src/client/locales.ts'

/** One recorded slot registration. */
interface Registration {
  options: { name: string; priority?: number; locale?: string; inject?: () => unknown }
  disposed: boolean
}

/** A fake client root plus the service doubles the plugin resolves by name. */
function bench(options: {
  current?: string
  workspacePath?: string
  chord?: string
  /** Compose without the mode switch, the way a profile with no omdsh-basemode does. */
  modes?: false
  /** What the Host's directory picker answers; null is the cancelled dialog. */
  picked?: string | null
  /** A Host whose picker this side cannot open — the browse backend. */
  pickerFails?: boolean
} = {}) {
  const current = options.current ?? 's1'
  const sessions = createSnapshotStore<SessionListState>({
    ids: [current as never], byId: {}, current: current as never, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  } as SessionListState)
  const workspaces = createSnapshotStore<WorkspaceListState>({
    items: [{
      workspaceId: 'w1' as never,
      path: options.workspacePath ?? '/workspace/project',
      title: 'project',
      sessionIds: [current as never],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  const opened: string[] = []
  /** Directories registered as projects, in order — the cold start's one write. */
  const created: string[] = []
  // The REAL registry, imported from the package that publishes it: a spec
  // driving this plugin through a hand-written double would keep passing after
  // the contract moved out from under it.
  const modes = new ModeSegmentRegistry()
  const services: Record<string, unknown> = {
    sessions: {
      list: sessions,
      open: (sessionId: string) => {
        opened.push(sessionId)
        sessions.set({ ...sessions.getSnapshot(), current: sessionId as never })
      },
    },
    workspaces: {
      list: workspaces,
      pickDirectory: async () => {
        if (options.pickerFails === true) throw new Error('no picker this side can open')
        return options.picked ?? null
      },
      create: async ({ path }: { path: string }) => {
        created.push(path)
        return { workspaceId: 'w-new', path, title: path, sessionIds: [] }
      },
    },
    ...options.modes === false ? {} : { sessionModes: modes },
  }
  // Composed only when a case asks for it, which is what makes the absent case
  // the DEFAULT one every other spec here runs under.
  const chordWatchers = new Set<() => void>()
  let chord = options.chord
  if (options.chord !== undefined) {
    services.shortcut = {
      chordLabel: (command: string) => (command === 'mode.code' ? chord : undefined),
      onBindings: (listener: () => void) => {
        chordWatchers.add(listener)
        return () => { chordWatchers.delete(listener) }
      },
    }
  }
  /** A later document revision, as the stream would deliver one. */
  const rebind = (next: string | undefined): void => {
    chord = next
    for (const watcher of chordWatchers) watcher()
  }
  const registrations: Registration[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    effect: (factory: () => (() => void) | void) => {
      const disposer = factory()
      if (disposer !== undefined) disposers.push(disposer)
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => en[key as keyof typeof en] ?? key,
    },
    on: () => () => {},
    slots: {
      register: (opts: Registration['options']) => {
        const entry: Registration = { options: opts, disposed: false }
        registrations.push(entry)
        return () => { entry.disposed = true }
      },
    },
    get: (service: string) => services[service],
    // The real restricted fiber waits for every named service and never runs
    // without them; the double answers the same question the specs ask.
    inject: (names: string[], callback: (sctx: unknown) => void) => {
      if (names.every(name => services[name] !== undefined)) callback(ctx)
    },
  } as unknown as ClientContext

  apply(ctx)
  /** Let the cold start's two awaited Host calls land. */
  const settled = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
  return { ctx, modes, registrations, sessions, workspaces, opened, created, disposers, rebind, settled }
}

/** The live scope, as the column's injected face publishes it. */
function scopeOf(b: ReturnType<typeof bench>, index = 0): Scope | undefined {
  const face = b.registrations[index]?.options.inject?.() as {
    hooks: { scope: { getSnapshot(): Scope | undefined } }
  }
  return face.hooks.scope.getSnapshot()
}

/** The plugin's own segment, as the registry currently holds it. */
const segment = (b: ReturnType<typeof bench>): ModeSegment | undefined =>
  b.modes.store.getSnapshot().find(entry => entry.id === SEGMENT_ID)

describe('omdsh-codemode browser half', () => {
  it('requires only services the web app itself composes, so this entry always activates', () => {
    // `sessionModes` is NOT here on purpose. cordis waits for an injected
    // service forever, and the client boot fails the whole page for a loader
    // entry left PENDING — so naming a contributed service here would turn a
    // profile without omdsh-basemode from "Code mode off" into "the page is dead".
    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'locale'])
    expect(inject).not.toContain('sessionModes')
  })

  it('does nothing at all when no composition published the switch', () => {
    // The off state, and the whole reason the registry is a restricted fiber:
    // the plugin mounts, registers nothing, and leaves the page as it found it.
    const b = bench({ modes: false })
    expect(b.registrations).toHaveLength(0)
    expect(b.modes.store.getSnapshot()).toEqual([])

    // Including the one thing it otherwise takes over: with no mode to show a
    // terminal in, a Code conversation opens like any other row.
    const service = b.ctx.get('sessions') as unknown as { open: (id: string) => void }
    service.open('code-session-a')
    expect(b.opened).toEqual(['code-session-a'])
  })

  it('contributes one segment, after the postures the deployment ships', () => {
    const b = bench()
    expect(segment(b)).toMatchObject({
      id: 'code',
      order: 20,
      label: en['mode.code'],
      hint: en['mode.code.hint'],
      available: true,
      active: false,
    })
  })

  it('takes the conversation column only once its segment is pressed', () => {
    const b = bench()
    expect(b.registrations).toHaveLength(0)

    b.modes.enter(SEGMENT_ID)
    expect(segment(b)?.active).toBe(true)
    expect(b.registrations).toHaveLength(1)
    // Lowest priority renders, and the shipped conversation holds the seat at
    // the default: a negative number is what shadows it.
    expect(b.registrations[0]?.options).toMatchObject({ name: 'conversation', priority: COLUMN_PRIORITY })
    expect(COLUMN_PRIORITY).toBeLessThan(0)
    expect(b.registrations[0]?.disposed).toBe(false)
  })

  it('gives the column back when another posture takes the switch', () => {
    const b = bench()
    // Another plugin's segment, registered the same way this one is.
    b.modes.register({ id: 'work', label: 'Work', enter: () => {} })
    b.modes.enter(SEGMENT_ID)
    expect(b.registrations[0]?.disposed).toBe(false)

    // Pressing Work marks it active, which clears this segment — and that flag
    // is the only thing the column follows.
    b.modes.update('work', { active: true })
    expect(segment(b)?.active).toBe(false)
    expect(b.registrations[0]?.disposed).toBe(true)
    expect(b.registrations).toHaveLength(1)

    // Coming back registers again rather than reviving the disposed entry.
    b.modes.enter(SEGMENT_ID)
    expect(b.registrations).toHaveLength(2)
    expect(b.registrations[1]?.disposed).toBe(false)
  })

  it('hands the column the conversation and its directory', () => {
    const b = bench({ current: 's9', workspacePath: '/workspace/other' })
    b.modes.enter(SEGMENT_ID)
    const face = b.registrations[0]?.options.inject?.() as { hooks: { scope: { getSnapshot(): unknown } } }
    expect(face.hooks.scope.getSnapshot()).toEqual({ sessionId: 's9', cwd: '/workspace/other' })
  })

  it('reports what its column is showing, which is never the selection', () => {
    // The whole reason the registry has a column scope: this mode SHOWS a
    // conversation without selecting it, so a surface beside the column that
    // read `sessions.current` would describe the conversation behind the
    // terminal instead of the terminal.
    const b = bench({ current: 's9', workspacePath: '/workspace/project' })
    b.workspaces.set({
      ...b.workspaces.getSnapshot(),
      items: [{ ...b.workspaces.getSnapshot().items[0]!, sessionIds: ['s9' as never, 'code-session-a' as never] }],
    })
    const service = b.ctx.get('sessions') as unknown as { open: (id: string) => void }
    service.open('code-session-a')

    // Matched rather than equalled: the registry passes the contributor's own
    // scope object through, and this one carries its Code session id as well.
    // The PUBLISHED type is the narrow pair, which is all a consumer may read.
    expect(b.modes.column.getSnapshot()).toMatchObject({
      sessionId: 'code-session-a',
      cwd: '/workspace/project',
    })
    // And the selection never moved, which is the fact that made it necessary.
    expect(b.sessions.getSnapshot().current).toBe('s9')
  })

  it('answers New Session with another terminal, and keeps the column', () => {
    // The whole point of the registry offering the request here: a mode whose
    // column is a terminal starts a terminal, and the user stays where they
    // are instead of being moved to a web conversation.
    const b = bench()
    b.modes.enter(SEGMENT_ID)
    const started = b.modes.requestNewSession()
    expect(started).toBe(true)
    const scope = scopeOf(b)
    expect(isCodeSessionId(scope?.codeSessionId ?? '')).toBe(true)
    expect(scope?.cwd).toBe('/workspace/project')
    expect(segment(b)?.active).toBe(true)
    // Never given up and taken back: one registration, never disposed.
    expect(b.registrations).toHaveLength(1)
    expect(b.registrations[0]?.disposed).toBe(false)
  })

  it('declines New Session when there is nowhere to run it', () => {
    const b = bench()
    b.modes.enter(SEGMENT_ID)
    b.sessions.set({ ...b.sessions.getSnapshot(), current: undefined })
    // Declining hands the request back to the frame, which shows a
    // conversation — the shipped behaviour, and the right one here.
    expect(b.modes.requestNewSession()).toBe(false)
  })

  it('hands the column a way to report what its terminal is called', () => {
    // A conversation renamed inside a terminal is a durable change made by
    // another process: no frame is pushed to this page, so the terminal's own
    // window title is the only word it gets.
    const b = bench()
    b.modes.enter(SEGMENT_ID)
    const face = b.registrations[0]?.options.inject?.() as CodeColumnInjected
    expect(typeof face.noteTitle).toBe('function')
    // An announcement for a directory whose conversation the host has not
    // named yet is dropped rather than guessed at.
    expect(() => { face.noteTitle('/workspace/project', 'proj — DeepSeek Harness') }).not.toThrow()
  })

  it('shows a Code conversation instead of handing it to the runtime', () => {
    // Opening one must never make it the runtime's current session: that is
    // what makes this host resume it, on a log its terminal owns.
    const b = bench({ current: 's9', workspacePath: '/workspace/project' })
    const service = b.ctx.get('sessions') as unknown as { open: (id: string) => void }
    b.workspaces.set({
      ...b.workspaces.getSnapshot(),
      items: [{ ...b.workspaces.getSnapshot().items[0]!, sessionIds: ['s9' as never, 'code-session-a' as never] }],
    })
    service.open('code-session-a')
    expect(b.opened).toEqual([])
    expect(segment(b)?.active).toBe(true)
    expect(scopeOf(b)).toEqual({
      sessionId: 'code-session-a',
      cwd: '/workspace/project',
      codeSessionId: 'code-session-a',
    })
    // Everything else opens exactly as it did.
    service.open('s9')
    expect(b.opened).toEqual(['s9'])
  })

  it('hands the shipped open back when the plugin goes away', () => {
    const b = bench()
    for (const dispose of b.disposers) dispose()
    const service = b.ctx.get('sessions') as unknown as { open: (id: string) => void }
    service.open('code-session-a')
    expect(b.opened).toEqual(['code-session-a'])
  })

  it('stays live with no conversation open, and the press starts the terminal', () => {
    // The composition this plugin is the ONLY mode plugin in: nothing selects a
    // conversation on the way in, so a segment reporting the derived scope was
    // dead on arrival — with omdsh-chatmode beside it a chat is always open and
    // the case never showed.
    const b = bench()
    b.sessions.set({ ...b.sessions.getSnapshot(), current: undefined })
    expect(segment(b)?.available).toBe(true)

    b.modes.enter(SEGMENT_ID)
    expect(segment(b)?.active).toBe(true)
    const scope = scopeOf(b)
    expect(scope?.cwd).toBe('/workspace/project')
    expect(isCodeSessionId(scope?.codeSessionId ?? '')).toBe(true)
  })

  it('asks the Host where to run when no project is registered at all', async () => {
    const b = bench({ picked: '/picked/repo' })
    b.sessions.set({ ...b.sessions.getSnapshot(), current: undefined })
    b.workspaces.set({ ...b.workspaces.getSnapshot(), items: [] })
    // Never unavailable: there is always a way to name a directory, so the
    // press asks rather than the tooltip explaining.
    expect(segment(b)?.available).toBe(true)

    b.modes.enter(SEGMENT_ID)
    // Asked and answered off the press, so the column arrives a turn later.
    expect(b.registrations).toHaveLength(0)
    await b.settled()
    expect(b.created).toEqual(['/picked/repo'])
    expect(segment(b)?.active).toBe(true)
    expect(scopeOf(b)?.cwd).toBe('/picked/repo')
  })

  it('leaves the column where it was when nobody picks anything', async () => {
    const b = bench({ picked: null })
    b.sessions.set({ ...b.sessions.getSnapshot(), current: undefined })
    b.workspaces.set({ ...b.workspaces.getSnapshot(), items: [] })

    b.modes.enter(SEGMENT_ID)
    await b.settled()
    expect(b.created).toEqual([])
    expect(segment(b)?.active).toBe(false)
    expect(b.registrations).toHaveLength(0)
    // Cancelling is an answer, so the offer stands.
    expect(segment(b)?.available).toBe(true)
  })

  it('says what is missing once the Host proves it cannot be asked', async () => {
    // A Host whose picker is the in-app browser (remote, headless): this side
    // cannot open it, so after one press the segment stops offering the cold
    // start and names the thing that would fix it.
    const b = bench({ pickerFails: true })
    b.sessions.set({ ...b.sessions.getSnapshot(), current: undefined })
    const projects = b.workspaces.getSnapshot().items
    b.workspaces.set({ ...b.workspaces.getSnapshot(), items: [] })

    b.modes.enter(SEGMENT_ID)
    await b.settled()
    expect(segment(b)).toMatchObject({
      available: false,
      unavailableHint: en['mode.code.unavailable'],
    })

    // And a project appearing is exactly what fixes it.
    b.workspaces.set({ ...b.workspaces.getSnapshot(), items: projects })
    expect(segment(b)?.available).toBe(true)
  })

  it('releases the column and the segment on teardown', () => {
    const b = bench()
    b.modes.enter(SEGMENT_ID)
    for (const dispose of b.disposers) dispose()
    expect(b.registrations[0]?.disposed).toBe(true)
    expect(segment(b)).toBeUndefined()
  })
})

describe('the chord the segment teaches', () => {
  it('names no key without a keybinding layer', () => {
    // The pressable segment is unchanged; its tooltip simply does not claim a
    // key this composition has no way to deliver.
    expect(segment(bench())?.hint).toBe(en['mode.code.hint'])
  })

  it('puts the chord after the hint once the switchboard is there', () => {
    expect(segment(bench({ chord: '⌥⌘3' }))?.hint).toBe(`${en['mode.code.hint']} · ⌥⌘3`)
  })

  it('follows a rebinding, so the tooltip lands with no reload', () => {
    const b = bench({ chord: '⌥⌘3' })
    b.rebind('⌘3')
    expect(segment(b)?.hint).toBe(`${en['mode.code.hint']} · ⌘3`)
  })

  it('drops back to the bare hint when the chord goes away', () => {
    // What a rebinding to the empty string produces: the segment stays on the
    // switch and stops teaching a key.
    const b = bench({ chord: '⌥⌘3' })
    b.rebind(undefined)
    expect(segment(b)?.hint).toBe(en['mode.code.hint'])
  })

  it('leaves the label alone — the pill has no room for a key', () => {
    expect(segment(bench({ chord: '⌥⌘3' }))?.label).toBe(en['mode.code'])
  })

  it('stops teaching a key when the keybinding layer unloads', () => {
    const b = bench({ chord: '⌥⌘3' })
    for (const dispose of b.disposers) dispose()
    expect(segment(b)?.hint === undefined || segment(b)?.hint === en['mode.code.hint']).toBe(true)
  })
})
