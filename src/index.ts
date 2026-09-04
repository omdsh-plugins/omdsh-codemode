/**
 * Code mode, host half: one WebSocket that hands the browser a harness
 * terminal running in a workspace directory.
 *
 * The web GUI and the terminal are two front doors onto the same harness, and
 * this plugin is the seam that lets one be shown inside the other. It adds no
 * agent, no session, and no filesystem access of its own: it starts
 * `dsh --profile <name>` — the same launcher this runtime was started with —
 * in a directory the session store already accounts, and relays bytes.
 *
 * The socket is fenced exactly like `/api`: a Host header naming us plus
 * same-origin browser markers. A route that hands out a live agent process
 * must be no more reachable than the API that drives one.
 * @module @omdsh-plugins/omdsh-codemode
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer } from 'ws'
import { chooseCodeSession, isCodeSessionId, isResumeRequest, mintCodeSessionId } from './code-session.ts'
import {
  clampDimension, DEFAULT_PROFILE, HarnessTerminalRegistry, RECONNECT_GRACE_MS, resolveHarnessCommand,
} from './harness-pty.ts'
import { TERMINAL_PATH } from './shared.ts'
import { bridge } from './terminal-socket.ts'
import { remoteResolver, type RemoteWorkspaceFace } from './remote.ts'
import { ProjectionRefolder, type ProjectionCacheFace } from './title-refold.ts'
import { isTrustedRequest } from './trust-fence.ts'
import {
  conversationBegunFromLog, WorkspaceAccountant,
  type SessionCatalogFace, type WorkspaceRegistryFace,
} from './workspace-account.ts'
import { CodeError, messageOf } from './wire.ts'

export {
  ROUTE_PREFIX, TERMINAL_PATH, CONTROL_PREFIX, decodeControl, decodeNotice, encodeControl, encodeNotice,
} from './shared.ts'
export type { TerminalControl, TerminalNotice } from './shared.ts'
export {
  chooseCodeSession, CODE_SESSION_PREFIX, isCodeSessionId, isResumeRequest, mintCodeSessionId,
} from './code-session.ts'
export {
  commandForSession, DEFAULT_PROFILE, HarnessTerminalRegistry, RECONNECT_GRACE_MS, resolveHarnessCommand,
  TITLE_SCAN_TAIL,
} from './harness-pty.ts'
export type { CodeTerminal, HarnessCommand, PtyDisposable, PtyLike, PtySpawner } from './harness-pty.ts'
export { REMDEV_SERVICE, remoteResolver } from './remote.ts'
export type { RemdevFace, RemoteWorkspaceFace, ResolveRemote } from './remote.ts'
export { readOscTitle } from './osc-title.ts'
export { ProjectionRefolder, REFOLD_SCHEDULE_MS } from './title-refold.ts'
export type { ProjectionCacheFace, RefoldClock } from './title-refold.ts'
export {
  ATTACH_SCHEDULE_MS, conversationBegunFromLog, logShowsTurn, RECONCILE_SCHEDULE_MS,
  WorkspaceAccountant,
} from './workspace-account.ts'
export type {
  AccountantClock, AccountantOptions, ConversationBegun, PersistedSessionFace,
  SessionCatalogFace, WorkspaceFace, WorkspaceRegistryFace,
} from './workspace-account.ts'
export { CodeError } from './wire.ts'

/** Cordis plugin name. */
export const name = 'omdsh-codemode'

/**
 * Services required before the socket can mount: the HTTP carrier, the
 * session store the working directory comes from, and the web runtime's
 * bind-derived trust list.
 */
export const inject = ['webServer', 'sessions', 'webRuntime']

/** Host-half configuration. */
export interface Config {
  /**
   * Profile the embedded terminal boots. Defaults to
   * {@link DEFAULT_PROFILE} — the profile this repository's sibling
   * `omdsh-tui` installs.
   */
  profile?: string
  /**
   * Launcher to run instead of re-executing this runtime's own entry. Set it
   * where the runtime was not started by `dsh` (a packaged shell, a test).
   */
  command?: string
  /** Arguments for {@link Config.command}; ignored without it. */
  args?: string[]
  /**
   * How long a terminal survives its socket dropping, in milliseconds. The
   * default keeps a running turn alive across a mode switch or a refresh.
   */
  reconnectGraceMs?: number
}

/**
 * The web runtime's bind-derived trust values, as this plugin reads them. A
 * structural mirror rather than an import: the concrete type lives in the
 * `@deepseek-ai/dsh-web-app` BUNDLE package, and a feature plugin depending on
 * a bundle is backwards. Drift is contained to these two lines.
 */
interface WebRuntimeTrust {
  /** LAN literals sampled at bind, followed by explicit `--trusted-host` authorities. */
  trustedHosts: readonly string[]
}

/**
 * Mount Code mode's host side.
 * @param ctx - host context carrying the webserver, sessions, and web runtime.
 * @param config - see {@link Config}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Resolved by name rather than off the ambient Context: a plugin compiled
  // outside the harness monorepo merges the browser and host `Context`
  // declarations into ONE program, so `ctx.sessions` is whichever the
  // compiler saw first. At runtime cordis publishes exactly one service per
  // name, and in this process it is the host one.
  const sessions = ctx.get('sessions') as unknown as SessionStore
  const webRuntime = ctx.get('webRuntime') as unknown as WebRuntimeTrust
  // Resolved rather than injected, and resolved LATE: a composition with no
  // workspace registry has no sidebar to put a Code conversation in, which is
  // a reason to skip the accounting rather than to refuse to mount — and the
  // registry publishes only after its own storage and persistence
  // dependencies start, which is routinely after this plugin.
  const workspaceRegistry = (): WorkspaceRegistryFace | undefined =>
    ctx.get('workspaceRegistry') as unknown as WorkspaceRegistryFace | undefined

  const command = resolveHarnessCommand(config.profile ?? DEFAULT_PROFILE, {
    ...config.command === undefined ? {} : { command: config.command },
    ...config.args === undefined ? {} : { args: config.args },
  })
  // Resolved late for the same reason as the workspace registry: the cache
  // publishes after its storage dependencies start, and a composition without
  // it lists no cold titles at all — which makes this a no-op rather than an
  // error.
  const projectionCache = (): ProjectionCacheFace | undefined =>
    ctx.get('sessionProjectionCache') as unknown as ProjectionCacheFace | undefined
  const refolder = new ProjectionRefolder(projectionCache)

  // A conversation renamed inside a terminal is a durable change made by
  // another process, and this host read the projection table once, at boot —
  // so its listing keeps the old name until it restarts. The terminal says so
  // through its window title; the answer is to re-read that one conversation.
  // Asked on every attach, never captured: the remote-development plugin can
  // load after this one and can come and go under HMR, so the answer has to be
  // read at the moment a terminal is wanted.
  const resolveRemote = remoteResolver(name => ctx.get(name))

  // Persistence is resolved late for the same reason as the registry: it
  // publishes after its storage backend starts, and a composition without
  // it has no cold conversations to group. The probe reads the log the
  // terminal actually wrote — `turn/start` — rather than a projection the
  // web host folds. The terminal is another process and does not write
  // `sessionListMetadata`, which is why every Code row used to stay in
  // Ungrouped after a turn.
  const sessionPersistence = (): SessionPersistenceFace | undefined =>
    ctx.get('sessionPersistence') as unknown as SessionPersistenceFace | undefined
  const accountant = new WorkspaceAccountant(
    workspaceRegistry,
    conversationBegunFromLog(async (sessionId) => {
      const store = sessionPersistence()
      if (store === undefined) throw new Error('omdsh-codemode: session persistence is not published')
      return (await store.inspect(sessionId)).events
    }),
    { catalog: sessionCatalog(sessionPersistence) },
  )

  const terminals = new HarnessTerminalRegistry(
    command,
    config.reconnectGraceMs ?? RECONNECT_GRACE_MS,
    (terminal) => {
      refolder.renamed(terminal.sessionId)
      // A terminal that CHANGED its window title has had a turn: the name is
      // generated from the first one, and the greeting title is filtered out
      // upstream. That is the earliest moment this host can know a Code
      // conversation began — and beginning is exactly what its workspace
      // account is waiting on, so settle it here rather than leaving the row
      // to the next scheduled attempt, which by then can be 90 seconds away.
      void accountant.settleNow(terminal.sessionId, terminal.cwd, true)
    },
    (cwd) => {
      const remote = resolveRemote(cwd)
      if (remote === undefined) return undefined
      // No profile is named, and that is deliberate. Which profile a SERVER
      // boots is a fact about that server's install — the remote plugin
      // created it and knows what is in it — and this plugin's own
      // `profile` names a composition on THIS machine that a server has
      // never heard of. Naming it here would boot a profile that does not
      // exist there.
      return (sessionId, _cwd, cols, rows) => remote.openAgent({ cols, rows, sessionId })
    },
  )
  // The accounts an earlier build wrote, corrected once per host: see
  // `reconcileAccounts`. Started here rather than inside the socket effect
  // because it is about conversations from previous runs, not about any
  // terminal this one will serve.
  ctx.effect(() => {
    accountant.reconcileSoon()
    return () => { accountant.dispose() }
  }, 'omdsh-codemode: group begun Code conversations, unaccount those that never began')

  /**
   * The directory a terminal runs in.
   *
   * The session store is the authority; the browser's own value is a
   * fallback, read only while the session is still hydrating, because the
   * first socket of a page load can genuinely arrive before the conversation
   * is attached. A relative fallback is refused rather than resolved against
   * the host's cwd, which would silently start an agent somewhere nobody
   * asked for.
   *
   * A resumed Code session usually lands on the fallback, and correctly so:
   * it is COLD here — the terminal that owns it is another process — so this
   * store has no header for it, while the browser reads its directory
   * straight out of the workspace group the row was clicked in.
   * @param sessionIds - the conversations that could name the directory, in
   * order of authority.
   * @param clientCwd - the directory the browser believes it is in.
   * @returns the absolute directory.
   */
  const resolveRoot = (sessionIds: readonly string[], clientCwd: string | undefined): string => {
    for (const sessionId of sessionIds) {
      const attached = sessions.get(sessionId as SessionId)?.header.cwd
      if (attached !== undefined && attached !== '') return attached
    }
    if (clientCwd !== undefined && clientCwd !== '') {
      if (!isAbsolute(clientCwd)) {
        throw new CodeError('bad-request', `working directory "${clientCwd}" is not absolute`)
      }
      return resolve(clientCwd)
    }
    throw new CodeError(
      'bad-request',
      `no working directory is known for session "${sessionIds[0] ?? ''}"`,
    )
  }

  /**
   * Which Code session this socket drives.
   *
   * Three answers, in the order of how much they are actually known:
   *
   * 1. **The conversation the browser named** — a Code row it was clicked on,
   *    or the terminal this page already had. A value that is not one of this
   *    plugin's own ids is refused rather than obeyed: the parameter decides
   *    what process gets spawned in a user's project, so it may only ever name
   *    a session Code mode itself created.
   * 2. **This host's live terminal in that directory**, which is what "the
   *    terminal for this project" means across a page reload — the socket
   *    drops, the process does not, and coming back must land on the same
   *    agent mid-turn.
   * 3. **The conversation the surface offers to continue** — the most recent
   *    Code conversation this project has, which is what pressing Code means
   *    after a restart: come back to what I was doing, not to an empty prompt.
   *    Offered rather than decided by the browser, because the live terminal
   *    above it always wins: a conversation that was just started has nothing
   *    on disk to be "most recent", and reviving an older one over a running
   *    agent would strand it.
   * 4. **A new conversation**, when this project has none.
   *
   * The order is the whole safety argument. A conversation another process is
   * driving must not be opened here — two live copies on one session log
   * interleave their sequence numbers and the log stops loading — so the only
   * revival is one where this host has nothing live, the offer names an id
   * this plugin minted, and the terminal it starts is marked as a resume so a
   * refusal cannot become this directory's answer to every later press.
   * @param requested - the `code` query parameter, when present.
   * @param offered - the `resume` query parameter, when present.
   * @param cwd - the directory the terminal will run in.
   * @returns the Code session id to attach.
   * @throws {CodeError} bad-request for an id this plugin did not mint.
   */
  const resolveCodeSession = (requested: string | null, offered: string | null, cwd: string): string => {
    for (const named of [requested, offered]) {
      if (named === null || named === '') continue
      if (!isCodeSessionId(named)) {
        throw new CodeError('bad-request', `"${named}" is not a Code session started by this plugin`)
      }
    }
    return chooseCodeSession(requested, terminals.liveIn(cwd)?.sessionId, offered) ?? mintCodeSessionId()
  }

  ctx.effect(() => {
    // A terminal belongs to the host that started it. Plugin teardown already
    // ends them, but a runtime that exits without unwinding its tree would
    // leave live agents behind — and an abandoned terminal is not merely
    // untidy: it keeps holding its conversation, so the next host offering to
    // reopen that conversation collides with it. `exit` is synchronous, which
    // is exactly what killing a pty needs.
    const reap = (): void => { terminals.disposeAll() }
    process.once('exit', reap)
    return () => { process.off('exit', reap) }
  }, 'omdsh-codemode: terminals do not outlive the host')

  ctx.effect(() => {
    // `noServer` because the carrier owns the listener; this only completes
    // the handshake on sockets the upgrade route hands us.
    const wss = new WebSocketServer({ noServer: true })
    const dispose = ctx.webServer.registerUpgrade({
      path: TERMINAL_PATH,
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!isTrustedRequest(req, webRuntime.trustedHosts)) {
          socket.destroy()
          return
        }
        const query = new URL(req.url ?? '/', 'http://omdsh-codemode.invalid').searchParams
        const sessionId = query.get('session')
        if (sessionId === null || sessionId === '') {
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          // The directory first: it is what a socket naming no conversation
          // is asking about, and what the answer below is keyed on.
          const requested = query.get('code')
          const offered = query.get('resume')
          let cwd: string
          let codeSessionId: string
          try {
            cwd = resolveRoot([requested ?? '', sessionId], query.get('cwd') ?? undefined)
            codeSessionId = resolveCodeSession(requested, offered, cwd)
          } catch (error) {
            // 1011 with a reason is the browser half's signal to stop
            // retrying and show what went wrong instead of spinning.
            ws.close(1011, messageOf(error).slice(0, 120))
            return
          }
          const remote = resolveRemote(cwd)
          // Attaching is asynchronous because a remote agent is a round trip —
          // several, on a server whose `.dsh-server` has to be installed first.
          terminals.attach(
            codeSessionId,
            cwd,
            clampDimension(Number(query.get('cols') ?? 80)),
            clampDimension(Number(query.get('rows') ?? 24)),
            // Named means RESUMED: a conversation that existed before this
            // socket asked for it, and so one another process may be holding.
            // A surface saying `fresh` minted the id a moment ago — New
            // Session in Code mode — which nobody can be holding and which
            // IS this directory's terminal from now on. A conversation taken
            // up from the offer is a resume like any other.
            isResumeRequest(requested ?? offered, query.get('fresh') === '1'),
          ).then((terminal) => {
            // The session may not exist on disk yet (nothing has been said in
            // it), so accounting is a schedule rather than a call; it is
            // idempotent per session, so a reconnect costs nothing.
            accountant.track(codeSessionId, cwd)
            if (ws.readyState !== ws.OPEN) {
              // The surface left while the terminal was being allocated, which
              // a remote one gives real time to. The bridge is what starts the
              // reconnect grace, and it starts it from a `close` that has
              // already been emitted — so this terminal would be the one kind
              // that never expires, holding its conversation against whoever
              // opens it next. Ask for the grace here instead: coming straight
              // back still lands on the same process.
              terminals.scheduleClose(codeSessionId)
              return
            }
            bridge(ws, terminal, terminals, {
              onEnd: () => { void settle(remote, accountant, codeSessionId, cwd) },
            })
          }).catch((error: unknown) => {
            ws.close(1011, messageOf(error).slice(0, 120))
          })
        })
      },
    })
    return () => {
      dispose()
      refolder.dispose()
      terminals.disposeAll()
      wss.close()
    }
  }, 'omdsh-codemode: harness terminal socket')
}

/**
 * Settle a conversation's workspace account once its terminal's socket has
 * ended.
 *
 * Both directions, which is why this runs on the socket ending rather than
 * only on a terminal exiting: leaving Code mode is the moment the user is
 * about to be somewhere else, and a conversation nothing was ever said in must
 * not be left accounted behind them — the frame reuses exactly that for New
 * Session. A conversation that did begin is attached here, which is also the
 * fastest its row ever appears.
 *
 * A REMOTE conversation is written on the server, so this host has nothing to
 * account for until the mirror has brought it home — and the mirror runs on a
 * timer, which is the wrong cadence for "the user just closed a terminal and is
 * looking at the sidebar". Pulling first makes the row appear immediately; a
 * pull that fails changes nothing, because the accountant's own retry schedule
 * is still running underneath.
 * @param remote - the remote workspace, when the directory is one.
 * @param accountant - the workspace accountant.
 * @param codeSessionId - the conversation.
 * @param cwd - the directory it ran in.
 * @returns completion.
 */
async function settle(
  remote: RemoteWorkspaceFace | undefined,
  accountant: WorkspaceAccountant,
  codeSessionId: string,
  cwd: string,
): Promise<void> {
  if (remote !== undefined) await remote.sync().catch(() => 0)
  await accountant.settleNow(codeSessionId, cwd)
}

/**
 * The persistence service as this plugin lists and inspects it. A structural
 * mirror: the concrete type lives behind `sessionPersistence`, and a
 * composition without it must leave Code mode working rather than fail to
 * install.
 */
interface SessionPersistenceFace {
  /**
   * Read one conversation's stored events without publishing it.
   * @param sessionId - the conversation.
   * @returns its events; rejects when the session has no log yet.
   */
  inspect(sessionId: string): Promise<{ events: readonly { type: string }[] }>
  /**
   * Lightweight listing from metadata, without a full-log parse.
   * @returns one header per materialized session.
   */
  list(): Promise<readonly { id: string; cwd?: string }[]>
}

/**
 * The session catalog the accountant's startup sweep reads, when persistence
 * has published.
 * @param persistence - resolves the store, or undefined without one.
 * @returns the catalog resolver.
 */
function sessionCatalog(
  persistence: () => SessionPersistenceFace | undefined,
): () => SessionCatalogFace | undefined {
  return () => {
    const store = persistence()
    if (store === undefined) return undefined
    return {
      list: async () => {
        const headers = await store.list()
        return headers.flatMap(header => {
          if (header.cwd === undefined || header.cwd === '') return []
          return [{ id: header.id, cwd: header.cwd }]
        })
      },
    }
  }
}
