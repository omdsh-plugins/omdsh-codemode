// The terminal table: one harness terminal per workspace directory, the
// command it re-executes, and the lifetime rules that make coming back land on
// the same process.
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  capTranscript, clampDimension, commandForSession, DEFAULT_PROFILE, HarnessTerminalRegistry,
  resolveHarnessCommand, TRANSCRIPT_LIMIT, type CodeTerminal, type HarnessCommand,
} from '../src/harness-pty.ts'
import { CodeError } from '../src/wire.ts'

/**
 * A stand-in for the harness launcher: a Node process that stays up, echoes
 * what it is told, and exits on demand. Spawning a real `dsh` in a spec would
 * start an agent.
 *
 * The trailing `--` matters: the registry appends `--session-id <id>` to
 * whatever launcher it was given, and node reads a bare `--session-id` as one
 * of its OWN options and refuses to start. Real launchers take the flag; this
 * one has to be told the rest of the line is not for it.
 */
const FAKE_LAUNCHER: HarnessCommand = {
  file: process.execPath,
  args: [
    '-e',
    'process.stdout.write("ready\\n"); process.stdin.resume(); process.stdin.on("data", () => process.exit(0))',
    '--',
  ],
}

/**
 * A stand-in that sets a window title twice, the way the harness terminal does
 * — once when it starts, and again when the conversation is renamed.
 */
const TITLE_WRITER = [
  'const esc = String.fromCharCode(0x1b), bel = String.fromCharCode(0x07);',
  'process.stdout.write(esc + "]0;first" + bel);',
  'setTimeout(() => process.stdout.write(esc + "]0;second" + bel), 30);',
  'process.stdin.resume();',
].join('')

/**
 * Greeting and generated name in ONE write — what a busy pty read actually
 * delivers, and what used to be treated as a greeting because only the last
 * announcement is visible.
 */
const TITLE_WRITER_BOTH = [
  'const esc = String.fromCharCode(0x1b), bel = String.fromCharCode(0x07);',
  'process.stdout.write(esc + "]0;DeepSeek Harness" + bel + esc + "]0;Unclear question — DeepSeek Harness" + bel);',
  'process.stdin.resume();',
].join('')

/** A reconnect that only replayed the already-named window title. */
const TITLE_WRITER_NAMED = [
  'const esc = String.fromCharCode(0x1b), bel = String.fromCharCode(0x07);',
  'process.stdout.write(esc + "]0;Unclear question — DeepSeek Harness" + bel);',
  'process.stdin.resume();',
].join('')

const registries: HarnessTerminalRegistry[] = []

/** A registry the suite always tears down, whatever the assertion does. */
function registry(grace?: number): HarnessTerminalRegistry {
  const created = new HarnessTerminalRegistry(FAKE_LAUNCHER, grace)
  registries.push(created)
  return created
}

afterEach(() => {
  for (const created of registries.splice(0)) created.disposeAll()
})

/** Wait until a predicate holds, or give up. */
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the terminal')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('resolveHarnessCommand', () => {
  it('re-executes this runtime\'s own launcher, at the named profile', () => {
    const command = resolveHarnessCommand('omdsh-tui')
    expect(command.file).toBe(process.execPath)
    // The entry this process was started with, then the launcher's own flag —
    // the same shape the terminal's `/resume` handoff builds.
    expect(command.args.slice(-3)).toEqual([process.argv[1], '--profile', 'omdsh-tui'])
  })

  it('prefers a configured command, which is what a packaged shell sets', () => {
    const command = resolveHarnessCommand('ignored', { command: '/opt/dsh', args: ['--profile', 'other'] })
    expect(command).toEqual({ file: '/opt/dsh', args: ['--profile', 'other'] })
  })

  it('names a profile by default', () => {
    expect(DEFAULT_PROFILE).toBe('omdsh-tui')
  })

  it('refuses rather than guessing when there is no launcher to re-execute', () => {
    const entry = process.argv[1]
    process.argv[1] = ''
    try {
      expect(() => resolveHarnessCommand('omdsh-tui')).toThrow(CodeError)
    } finally {
      process.argv[1] = entry as string
    }
  })
})

describe('capTranscript', () => {
  it('keeps a short transcript whole', () => {
    expect(capTranscript('hello')).toBe('hello')
  })

  it('drops from the head, because the tail is what a reconnect needs', () => {
    const capped = capTranscript(`${'a'.repeat(TRANSCRIPT_LIMIT)}TAIL`)
    expect(capped.length).toBe(TRANSCRIPT_LIMIT)
    expect(capped.endsWith('TAIL')).toBe(true)
  })
})

describe('clampDimension', () => {
  it('rounds into a grid the pty will accept', () => {
    expect(clampDimension(80.7)).toBe(80)
    expect(clampDimension(1)).toBe(2)
    expect(clampDimension(99999)).toBe(1000)
  })

  it('falls back rather than handing NaN to the pty', () => {
    expect(clampDimension(Number.NaN)).toBe(24)
  })
})

describe('commandForSession', () => {
  it('names the session the terminal must drive', () => {
    expect(commandForSession({ file: 'dsh', args: ['--profile', 'omdsh-tui'] }, 'code-session-1'))
      .toEqual({ file: 'dsh', args: ['--profile', 'omdsh-tui', '--session-id', 'code-session-1'] })
  })

  it('leaves the launcher it was given alone', () => {
    const base = { file: 'dsh', args: ['--profile', 'omdsh-tui'] }
    commandForSession(base, 'code-session-1')
    expect(base.args).toEqual(['--profile', 'omdsh-tui'])
  })
})

describe('HarnessTerminalRegistry', () => {
  it('keys by Code session, so a conversation has one terminal', async () => {
    const table = registry()
    const first = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => first.transcript.includes('ready'))
    const again = await table.attach('code-session-1', tmpdir(), 100, 30)
    expect(again).toBe(first)
    // Another conversation in the SAME directory is another terminal: that is
    // what makes an earlier Code session something a person can come back to.
    const other = await table.attach('code-session-2', tmpdir(), 80, 24)
    expect(other).not.toBe(first)
  })

  it('reports its own live terminal for a directory, so a reload lands on it', async () => {
    const table = registry()
    const terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => terminal.transcript.includes('ready'))
    // What a socket naming no conversation is answered with: a process THIS
    // host started and has not reaped — never a guess from the session list,
    // whose newest Code conversation is the one another host may still hold.
    expect(table.liveIn(tmpdir())).toBe(terminal)
    expect(table.liveIn(process.cwd())).toBeUndefined()
  })

  it('reports the newest live terminal where a directory has several', async () => {
    const table = registry()
    await table.attach('code-session-1', tmpdir(), 80, 24)
    const second = await table.attach('code-session-2', tmpdir(), 80, 24)
    await until(() => second.transcript.includes('ready'))
    expect(table.liveIn(tmpdir())).toBe(second)
  })

  it('never answers with a terminal opened for a named conversation', async () => {
    const table = registry()
    const project = await table.attach('code-session-1', tmpdir(), 80, 24)
    // A Code row the user clicked: that conversation's terminal, not the
    // directory's — and the only kind that can fail to take its session,
    // because another process may be holding it. Handing it back here would
    // make one refused conversation the answer to every later press of Code.
    await table.attach('code-session-2', tmpdir(), 80, 24, true)
    await until(() => project.transcript.includes('ready'))
    expect(table.liveIn(tmpdir())).toBe(project)
  })

  it('reports a terminal renaming its conversation, but not its greeting', async () => {
    // Every terminal program sets a window title when it starts; the one after
    // that is a conversation being renamed, which is a durable change this
    // process would otherwise keep serving the old name for.
    const renamed: string[] = []
    const table = new HarnessTerminalRegistry(
      { file: process.execPath, args: ['-e', TITLE_WRITER, '--'] },
      undefined,
      terminal => { renamed.push(terminal.title ?? '') },
    )
    registries.push(table)
    const terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => terminal.title === 'second')
    expect(renamed).toEqual(['second'])
  })

  it('reports a name that arrived with the greeting in the same read', async () => {
    const renamed: string[] = []
    const table = new HarnessTerminalRegistry(
      { file: process.execPath, args: ['-e', TITLE_WRITER_BOTH, '--'] },
      undefined,
      terminal => { renamed.push(terminal.title ?? '') },
    )
    registries.push(table)
    const terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => terminal.title === 'Unclear question — DeepSeek Harness')
    expect(renamed).toEqual(['Unclear question — DeepSeek Harness'])
  })

  it('reports a first announcement that already names the conversation', async () => {
    const renamed: string[] = []
    const table = new HarnessTerminalRegistry(
      { file: process.execPath, args: ['-e', TITLE_WRITER_NAMED, '--'] },
      undefined,
      terminal => { renamed.push(terminal.title ?? '') },
    )
    registries.push(table)
    const terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => terminal.title === 'Unclear question — DeepSeek Harness')
    expect(renamed).toEqual(['Unclear question — DeepSeek Harness'])
  })

  it('reports no live terminal once its process is gone', async () => {
    const table = registry()
    const terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => terminal.transcript.includes('ready'))
    terminal.pty.write('q\r')
    await until(() => terminal.exited)
    // An exited process is not something to hand a reconnecting surface: the
    // next attach spawns a replacement for that same conversation.
    expect(table.liveIn(tmpdir())).toBeUndefined()
    table.close('code-session-1')
    expect(table.liveIn(tmpdir())).toBeUndefined()
  })

  it('replays a transcript rather than starting over', async () => {
    const table = registry()
    const terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => terminal.transcript.includes('ready'))
    expect(table.get('code-session-1')?.transcript).toContain('ready')
  })

  it('replaces an exited terminal instead of handing back a dead one', async () => {
    const table = registry()
    const terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => terminal.transcript.includes('ready'))
    // A pty starts in canonical mode, so the line has to be completed before
    // the child sees it at all.
    terminal.pty.write('q\r')
    await until(() => terminal.exited)
    const replacement = await table.attach('code-session-1', tmpdir(), 80, 24)
    expect(replacement).not.toBe(terminal)
    expect(replacement.exited).toBe(false)
  })

  it('holds a dropped terminal for the grace, and attaching cancels the reap', async () => {
    const table = registry(40)
    const terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => terminal.transcript.includes('ready'))
    table.scheduleClose('code-session-1')
    expect(await table.attach('code-session-1', tmpdir(), 80, 24)).toBe(terminal)
    await new Promise(resolve => setTimeout(resolve, 80))
    // The cancelled reap did not fire: coming back landed on the same process.
    expect(table.get('code-session-1')).toBe(terminal)
  })

  it('ends a terminal when the grace expires', async () => {
    const table = registry(10)
    const terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    await until(() => terminal.transcript.includes('ready'))
    table.scheduleClose('code-session-1')
    await until(() => table.get('code-session-1') === undefined)
  })

  it('ends one now on an explicit close', async () => {
    const table = registry()
    await table.attach('code-session-1', tmpdir(), 80, 24)
    table.scheduleClose('code-session-1', 0)
    expect(table.get('code-session-1')).toBeUndefined()
  })

  it('surfaces a launcher that will not start, however the platform reports it', async () => {
    // node-pty raises a missing executable synchronously on some platforms and
    // as an immediate exit on others; either way the surface must learn about
    // it rather than sit at a live-looking prompt.
    const table = new HarnessTerminalRegistry({ file: '/nonexistent/launcher', args: [] })
    registries.push(table)
    let thrown: unknown
    let terminal: CodeTerminal | undefined
    try {
      terminal = await table.attach('code-session-1', tmpdir(), 80, 24)
    } catch (error) {
      thrown = error
    }
    if (thrown !== undefined) {
      expect(thrown).toBeInstanceOf(CodeError)
      return
    }
    await until(() => terminal?.exited === true)
  })

  it('hands a directory the resolver claims to the remote spawner instead', async () => {
    const spawned: Array<{ sessionId: string; cwd: string; cols: number; rows: number }> = []
    const fake = {
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
    const table = new HarnessTerminalRegistry(
      FAKE_LAUNCHER,
      undefined,
      undefined,
      cwd => (cwd === '/mirror'
        ? (sessionId, target, cols, rows) => {
          spawned.push({ sessionId, cwd: target, cols, rows })
          return Promise.resolve(fake)
        }
        : undefined),
    )
    registries.push(table)
    const remote = await table.attach('code-session-1', '/mirror', 90, 30)
    expect(remote.pty).toBe(fake)
    // The session id crosses to the spawner unchanged: it is what the remote
    // launcher is given as `--session-id`, and what the mirrored conversation
    // comes home under.
    expect(spawned).toEqual([{ sessionId: 'code-session-1', cwd: '/mirror', cols: 90, rows: 30 }])
    // A directory the resolver declines still spawns locally, which is the
    // property that makes remote support additive rather than a mode.
    const local = await table.attach('code-session-2', tmpdir(), 80, 24)
    expect(local.pty).not.toBe(fake)
  })
})
