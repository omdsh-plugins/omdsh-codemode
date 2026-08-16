/**
 * Code mode, browser half: one segment in the session-mode switch, and the
 * conversation column while that segment is on.
 *
 * Two registrations, and the second is the interesting one. `conversation` is
 * ui-layout's SINGLE seat for the whole centre column, held by the web
 * conversation itself; a second entry at a lower priority shadows it. So this
 * plugin does not register there at mount — it registers when the segment is
 * pressed and disposes when the segment loses the column, which is what makes
 * Code mode a mode rather than a replacement.
 *
 * The segment also carries what the switch and the sidebar need to SHOW a
 * mode: a tone and a glyph, plus the one question only this plugin can answer
 * — whether a given conversation is one of its own ([code-session](../code-session.ts)).
 * The switch renders the glyph; the sidebar paints the tone as a leading dot
 * on every row. Both are the registry's business, not this file's; all this
 * plugin does is answer for itself.
 *
 * Its dependency on the mode system is the switch, not the package: the
 * registry is resolved by service name, so a composition without
 * `@omdsh-plugins/omdsh-base` never publishes `sessionModes` and this plugin
 * does nothing at all. That is the off state, and it needs no configuration.
 *
 * What carries that dependency is a RESTRICTED fiber and not this plugin's own
 * `inject`, because the two are not the same thing to the client's boot audit.
 * cordis's inject wait has no timeout, so a top-level `inject` naming a service
 * nothing composed leaves this loader entry PENDING forever — and the web
 * client sweeps every entry once the tree settles and fails the whole page for
 * any that is not ACTIVE. A fiber started inside `apply` is not a loader entry,
 * so waiting forever costs nothing. Off has to mean inert, never fatal.
 * @module @omdsh-plugins/omdsh-code/client
 */

import { createElement } from 'react'
import type { ClientContext, ISessions, IWorkspaces, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { isCodeSessionId } from '../code-session.ts'
import type { CodeColumnInjected } from './contract.ts'
import { CodeModeController } from './code-mode.ts'
import { TerminalTitleSync } from './title-sync.ts'
import type { SessionModes } from './session-modes.ts'
import { MODE_COMMAND, SHORTCUT_SERVICE, withChord, type IShortcutClient } from './shortcut.ts'
import { SESSION_MODES } from './session-modes.ts'
import { CodeColumn } from './CodeColumn.tsx'
import { en, zh, type CodeKey } from './locales.ts'

export type { Scope } from './api.ts'
export { terminalUrl } from './api.ts'
export type { CodeColumnInjected, CodeColumnProps } from './contract.ts'
export { CodeModeController } from './code-mode.ts'
export type { CodeModeDeps } from './code-mode.ts'
export { TerminalTitleSync, TITLE_REFRESH_SCHEDULE_MS } from './title-sync.ts'
export type { TitleSyncClock, TitleSyncDeps } from './title-sync.ts'
export type { ModeSegment, SessionModes } from './session-modes.ts'
export { SESSION_MODES } from './session-modes.ts'
export { CodeSurface, type CodeSurfaceProps } from './CodeSurface.tsx'
export { CodeColumn } from './CodeColumn.tsx'
export type { CodeKey } from './locales.ts'
export { CODE_SESSION_PREFIX, isCodeSessionId, mintCodeSessionId } from '../code-session.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Code segment and its column's copy. */
    'omdsh-code': CodeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'omdsh-code'

/** The segment id this plugin contributes. */
export const SEGMENT_ID = 'code'

/**
 * The colour Code mode is drawn in, wherever a mode has a colour: this
 * segment's glyph in the switch, and every Code row's dot in the sidebar.
 *
 * A design token rather than a literal, so both surfaces follow the theme the
 * reader chose — and the error red specifically, because the three modes need
 * three colours a person can tell apart at 6px and this is the one the harness
 * palette keeps furthest from the running blue and the finished green.
 */
export const CODE_TONE = 'var(--dsw-alias-state-error-primary)'

/**
 * Priority of the conversation-column registration.
 *
 * Lowest renders, and ui-conversation holds the seat at the default 0 — so a
 * negative number is what shadows it. Same-priority registrations throw, which
 * is why this is not 0.
 */
export const COLUMN_PRIORITY = -10

/**
 * Required services (cordis fiber inject).
 *
 * Every name here is composed by `dsh-base` and `dsh-web-app` themselves, so
 * this entry always activates. `sessionModes` is deliberately NOT one of them
 * — see {@link apply}.
 */
export const inject = ['slots', 'sessions', 'workspaces', 'locale']

/**
 * Mount Code mode's browser side.
 *
 * The whole of it hangs off one restricted fiber waiting on the segment
 * registry, because everything this plugin does in the browser is either a
 * registration into the mode switch or something that follows from one. No
 * switch, no work to do — and, deliberately, no trace either: with the mode
 * absent this plugin leaves the page exactly as it found it, which is what
 * "not installed" already looks like.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject([SESSION_MODES], (mctx: ClientContext) => {
    const modes = mctx.get(SESSION_MODES) as unknown as SessionModes | undefined
    // Reachable when the name is provided by a fiber that is not active.
    if (modes === undefined) return
    mountMode(mctx, modes)
  })
}

/**
 * Mount the segment and everything that follows from it.
 * @param ctx - the restricted context the registry resolved in. Every effect
 * below rides it rather than the root, so a mode switch that unloads at runtime
 * withdraws Code mode with it instead of leaving this plugin holding a registry
 * nobody publishes any more.
 * @param modes - the resolved segment registry.
 */
function mountMode(ctx: ClientContext, modes: SessionModes): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'omdsh-code: dictionaries')

  const sessions = ctx.get('sessions') as unknown as ISessions
  const workspaces = ctx.get('workspaces') as unknown as IWorkspaces

  // `refresh` is the sessions runtime's own baseline pull, and it is not on
  // the narrow ISessions face features are handed — the domain expects the
  // wire pump to be the only caller. It is the honest call for both readers
  // below anyway: each answers a durable change made OUTSIDE this page, by the
  // Host or by a terminal, which nothing else re-pulls before the next
  // reconnect.
  const refreshSessions = (): void => {
    void (sessions as unknown as { refresh?: () => Promise<void> }).refresh?.()
  }

  const controller = new CodeModeController({
    sessions: sessions.list,
    workspaces: workspaces.list,
    enterCode: () => { modes.update(SEGMENT_ID, { active: true }) },
    clearSelection: () => { sessions.clear() },
    refreshSessions,
    pickDirectory: () => workspaces.pickDirectory(),
    // The Host's canon for the path, which is what the workspace is keyed on;
    // an already-registered directory resolves to the same project rather than
    // a second one, so pressing Code twice on the same answer is idempotent.
    registerProject: async (path: string) => (await workspaces.create({ path })).path,
  })
  ctx.effect(() => controller.start(), 'omdsh-code: derived terminal scope')

  // Opening a Code conversation shows its terminal — and nothing else. It is
  // NOT handed to the web runtime, because a selected conversation is one this
  // host resumes (the surfaces that follow a selection ask for its commands
  // and its models, and both resolve an agent). That would put a second live
  // copy on a log the terminal in another process is appending to, and two
  // writers on one session log interleave sequence numbers until the log stops
  // loading at all — a conversation lost, not merely a stale name.
  //
  // A prototype method shadowed by an own property, restored by deleting it:
  // every route in — the sidebar, search, the workspace browser — calls
  // `ctx.sessions.open`, and withdrawing this plugin hands the original back.
  ctx.effect(() => {
    const service = sessions as unknown as { open: ISessions['open'] }
    const shipped = service.open.bind(sessions)
    const owned = Object.prototype.hasOwnProperty.call(sessions, 'open')
    service.open = (sessionId) => {
      // A conversation with no directory anywhere cannot be shown as a
      // terminal; letting the runtime have it is better than nothing at all.
      if (isCodeSessionId(sessionId) && controller.showConversation(sessionId)) return
      shipped(sessionId)
    }
    return () => {
      if (owned) service.open = shipped
      else delete (service as Partial<typeof service>).open
    }
  }, 'omdsh-code: a terminal conversation is shown, never selected')

  // A conversation renamed inside a terminal — `/rename`, or the name the
  // agent generates after the first turn — is a durable change this page never
  // hears about: the web host holds no agent for that conversation, so no
  // frame is pushed and the sidebar keeps the old name until the next reload.
  // The terminal's own window title is the announcement; the session list stays
  // the authority on what the name is.
  const titles = new TerminalTitleSync({
    listedTitle: sessionId => sessions.list.getSnapshot().byId[sessionId as SessionId]?.title,
    refresh: refreshSessions,
  })
  ctx.effect(() => () => { titles.dispose() }, 'omdsh-code: terminal title sync')

  const t = ctx.locale.bind(NS)
  /**
   * The chord this segment teaches. Empty unless a keybinding layer is composed
   * AND its document has arrived, which is why it is re-applied through
   * {@link applyCopy} rather than read once at registration.
   */
  let chord: string | undefined
  /** This plugin's segment copy, in the reader's current language. */
  const copy = () => ({
    label: t('mode.code'),
    // The chord rides the HINT, not the label: the pill is three short words
    // side by side and has no room for a key, while the tooltip is already the
    // place this control explains itself.
    hint: withChord(t('mode.code.hint'), chord),
    unavailableHint: t('mode.code.unavailable'),
  })
  /**
   * Re-apply this segment's copy. The single writer of its text, so the two
   * things that can change it — the reader's language and the document's
   * chords — cannot disagree about what the other one said.
   */
  const applyCopy = (): void => { modes.update(SEGMENT_ID, copy()) }

  /** The switch's glyph for this mode; one element, so the registry never re-publishes for it. */
  const icon = createElement(IconCodeOutline16, { size: 14 })

  ctx.effect(() => modes.register({
    id: SEGMENT_ID,
    // After Chat (0) and Work (10): the postures this deployment ships come
    // first, and a contributed one joins the end.
    order: 20,
    ...copy(),
    tone: CODE_TONE,
    icon,
    // The one classification only this plugin can make. Every surface that
    // marks conversations by mode asks the registry, and the registry asks
    // here — so the sidebar gains Code rows by this plugin being installed,
    // with nothing about Code in the code that paints them.
    owns: isCodeSessionId,
    // What this mode's column is showing, for the surfaces beside it. It has
    // to be declared, because the ordinary answer — the selected conversation
    // — is one this mode deliberately never gives: a Code conversation is
    // SHOWN, never selected, so a file tree keyed on the selection would sit
    // beside this terminal describing the conversation behind it. Read only
    // while this segment holds the column, which is why the store below can go
    // on deriving what Code mode WOULD show at all times.
    scope: controller.scope,
    // Whether a terminal has anywhere to run, which this segment used to answer
    // with the SCOPE — derived from the selected conversation, and so empty on a
    // page that has never opened one. That made Code permanently grey in the one
    // composition where this plugin is the only mode plugin: a fresh install
    // with `omdsh-base` alone selects nothing, where `omdsh-justchat`'s managed
    // Chat workspace always has something open. What a terminal needs is a
    // DIRECTORY, and a conversation is only one of the ways to name one.
    available: controller.enterable.getSnapshot(),
    // Pressing Code is the whole state change. Marking the segment active
    // clears the others, and the column registration below follows from that
    // one flag rather than from a second source of truth.
    enter: () => {
      // Something to show already, or a project to start a terminal in: take
      // the column now.
      if (controller.ensureScope()) {
        modes.update(SEGMENT_ID, { active: true })
        return
      }
      // Neither, which is the cold start. Asking the Host where is the only
      // honest answer, and the column is taken when (and if) one comes back —
      // the controller does that itself, through `enterCode` above.
      void controller.chooseProject()
    },
    // New Session, while this mode holds the column, is a request for another
    // terminal — not for the web conversation the frame would otherwise show,
    // which would take the column and change the mode under the user. A
    // directory it cannot resolve is declined rather than guessed at, and the
    // frame's own New Session runs instead.
    newSession: (workspaceId?: string) => controller.startNewConversation(workspaceId),
  }), 'omdsh-code: mode segment')

  // Nowhere to run, and no way left to ask where — see `enterable`.
  const followAvailability = (): void => {
    modes.update(SEGMENT_ID, { available: controller.enterable.getSnapshot() })
  }
  ctx.effect(() => controller.enterable.subscribe(followAvailability), 'omdsh-code: segment availability')

  ctx.effect(() => ctx.on('locale/change', () => { applyCopy() }), 'omdsh-code: segment copy')

  // The chord this segment teaches. A RESTRICTED fiber: a composition with no
  // keybinding layer has no chord to name, and the switch is still the whole
  // way into this mode — so its absence costs a tooltip suffix and nothing else.
  ctx.inject([SHORTCUT_SERVICE], (sctx) => {
    const shortcut = sctx.get(SHORTCUT_SERVICE) as unknown as IShortcutClient | undefined
    if (shortcut === undefined) return
    const followChord = (): void => {
      const next = shortcut.chordLabel(MODE_COMMAND)
      if (next === chord) return
      chord = next
      applyCopy()
    }
    sctx.effect(() => {
      const off = shortcut.onBindings(followChord)
      // The document usually lands after this fiber does, so the first read is
      // typically empty and the subscription is what fills it in.
      followChord()
      // Back to naming no key when the layer unloads, rather than teaching one
      // that no longer exists.
      return () => { off(); chord = undefined; applyCopy() }
    }, 'omdsh-code: follow the mode chord')
  })

  // The column, mounted and unmounted by the segment's own active flag. The
  // registry allows exactly one active segment, so pressing Chat or Work is
  // what takes the column back — this side only has to notice.
  let column: (() => void) | undefined
  const releaseColumn = (): void => {
    column?.()
    column = undefined
  }
  const followActive = (): void => {
    const active = modes.store.getSnapshot().find(segment => segment.id === SEGMENT_ID)?.active === true
    if (active === (column !== undefined)) return
    if (!active) {
      releaseColumn()
      return
    }
    column = ctx.slots.register({
      name: 'conversation',
      priority: COLUMN_PRIORITY,
      locale: NS,
      inject: (): CodeColumnInjected => ({
        hooks: { scope: controller.scope },
        noteAttached: (cwd, codeSessionId) => { controller.noteAttached(cwd, codeSessionId) },
        noteTitle: (cwd, title) => {
          // Reported against the directory, like every other terminal fact;
          // which conversation that is, is the host's answer, and the mode is
          // where that answer landed.
          const codeSessionId = controller.codeSessionIn(cwd)
          if (codeSessionId !== undefined) titles.announced(codeSessionId, title)
        },
      }),
    }, CodeColumn)
  }
  ctx.effect(() => {
    const unsubscribe = modes.store.subscribe(followActive)
    followActive()
    return () => {
      unsubscribe()
      releaseColumn()
    }
  }, 'omdsh-code: conversation column')
}
