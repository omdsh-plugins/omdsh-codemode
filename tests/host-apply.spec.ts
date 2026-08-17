// The host plugin body: one fenced upgrade route, the directory it resolves,
// and what it takes down with it.
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name, TERMINAL_PATH } from '../src/index.ts'

/** One recorded upgrade registration. */
interface Upgrade {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
}

/** A socket double: the fence destroys it, the handshake would not. */
function socketDouble() {
  return { destroy: vi.fn(), on: vi.fn(), removeListener: vi.fn(), write: vi.fn() } as unknown as Duplex & { destroy: ReturnType<typeof vi.fn> }
}

/** A request the fence accepts: loopback Host plus same-origin markers. */
function trustedRequest(url: string): IncomingMessage {
  return {
    url,
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
    },
  } as unknown as IncomingMessage
}

/** A fake host root with the three services the plugin resolves by name. */
function bench(options: { cwd?: string } = {}) {
  const upgrades: Upgrade[] = []
  const disposers: (() => void)[] = []
  const services: Record<string, unknown> = {
    sessions: {
      get: (id: string) => (id === 'live'
        ? { header: { cwd: options.cwd ?? tmpdir() } }
        : undefined),
    },
    webRuntime: { trustedHosts: [] },
  }
  const ctx = {
    effect: (factory: () => (() => void) | void) => {
      const disposer = factory()
      if (disposer !== undefined) disposers.push(disposer)
    },
    get: (service: string) => services[service],
    webServer: {
      registerUpgrade: (upgrade: Upgrade) => {
        upgrades.push(upgrade)
        return () => {}
      },
    },
  } as unknown as Context
  // A launcher that is never actually started: every case below is refused
  // before the handshake, and a spec must not spawn an agent.
  apply(ctx, { command: process.execPath, args: ['-e', ''] })
  return { upgrades, disposers }
}

describe('omdsh-codemode host half', () => {
  it('names itself and the services it resolves', () => {
    expect(name).toBe('omdsh-codemode')
    expect(inject).toEqual(['webServer', 'sessions', 'webRuntime'])
  })

  it('registers exactly one upgrade, on its own path', () => {
    const b = bench()
    expect(b.upgrades.map(upgrade => upgrade.path)).toEqual([TERMINAL_PATH])
  })

  it('destroys an untrusted socket instead of handing out a process', () => {
    const b = bench()
    const socket = socketDouble()
    // No same-origin markers: the /api gateway would refuse this too.
    const request = { url: `${TERMINAL_PATH}?session=live`, headers: { host: 'evil.example' } } as unknown as IncomingMessage
    b.upgrades[0]?.handler(request, socket, Buffer.alloc(0))
    expect(socket.destroy).toHaveBeenCalledOnce()
  })

  it('destroys a socket that names no conversation', () => {
    const b = bench()
    const socket = socketDouble()
    b.upgrades[0]?.handler(trustedRequest(TERMINAL_PATH), socket, Buffer.alloc(0))
    expect(socket.destroy).toHaveBeenCalledOnce()
  })

  it('takes the socket, the process hook, and every terminal down with the plugin', () => {
    // Three effects: the account sweep, the exit hook that stops terminals
    // outliving their host, and the upgrade route itself.
    const b = bench()
    expect(b.disposers).toHaveLength(3)
    expect(() => { for (const dispose of b.disposers) dispose() }).not.toThrow()
  })
})
