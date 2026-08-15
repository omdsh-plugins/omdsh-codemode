// Getting a Code conversation out of Ungrouped and into its workspace group:
// the retry that waits for a session to exist, and the cases it must not act on.
import { describe, expect, it, vi } from 'vitest'
import {
  ATTACH_SCHEDULE_MS, WorkspaceAccountant,
  type AccountantClock, type WorkspaceFace, type WorkspaceRegistryFace,
} from '../src/workspace-account.ts'

/** A clock whose timers fire when the spec says so, in schedule order. */
function fakeClock(): AccountantClock & { run: () => Promise<void>; pending: number } {
  const queue: (() => void)[] = []
  return {
    setTimeout: (callback) => {
      queue.push(callback)
      return queue.length
    },
    clear: (handle) => {
      const index = (handle as number) - 1
      if (queue[index] !== undefined) queue[index] = () => {}
    },
    get pending() {
      return queue.length
    },
    run: async () => {
      const due = queue.splice(0)
      for (const callback of due) callback()
      // The attempts are async inside the timer; let their promises settle.
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

/** A registry whose one workspace starts refusing and then accepts. */
function registryDouble(options: { path?: string; acceptAfter?: number } = {}) {
  const attached: string[] = []
  let attempts = 0
  const workspace: WorkspaceFace = {
    get sessionIds() {
      return [...attached]
    },
    attachSession: async (sessionId: string) => {
      attempts++
      // The ordinary case while a terminal has not been typed into: the
      // registry has no persisted header for the id and rejects.
      if (attempts <= (options.acceptAfter ?? 0)) throw new Error('unknown session')
      attached.push(sessionId)
    },
  }
  const registry: WorkspaceRegistryFace = {
    resolveByPath: async (path: string) => (path === (options.path ?? '/repo') ? workspace : undefined),
  }
  return { registry, attached, get attempts() { return attempts } }
}

describe('WorkspaceAccountant', () => {
  it('accounts for a Code conversation once its log exists', async () => {
    const clock = fakeClock()
    const registry = registryDouble({ acceptAfter: 2 })
    const accountant = new WorkspaceAccountant(() => registry.registry, [1, 1, 1, 1], clock)
    accountant.track('code-session-1', '/repo')

    await clock.run()
    expect(registry.attached).toEqual([])
    await clock.run()
    expect(registry.attached).toEqual([])
    await clock.run()
    // The third attempt is the first one after the session materialized.
    expect(registry.attached).toEqual(['code-session-1'])
  })

  it('stops once it lands, rather than re-attaching forever', async () => {
    const clock = fakeClock()
    const registry = registryDouble()
    const accountant = new WorkspaceAccountant(() => registry.registry, [1, 1, 1], clock)
    accountant.track('code-session-1', '/repo')
    await clock.run()
    await clock.run()
    expect(registry.attempts).toBe(1)
  })

  it('gives up quietly when the schedule runs out', async () => {
    const clock = fakeClock()
    const registry = registryDouble({ acceptAfter: 99 })
    const accountant = new WorkspaceAccountant(() => registry.registry, [1, 1], clock)
    accountant.track('code-session-1', '/repo')
    await clock.run()
    await clock.run()
    await clock.run()
    // Two attempts, no third schedule, and no throw: a terminal nobody typed
    // into leaves no row, which is the intended outcome and not an error.
    expect(registry.attempts).toBe(2)
    expect(clock.pending).toBe(0)
  })

  it('runs one schedule per session however often it is tracked', async () => {
    const clock = fakeClock()
    const registry = registryDouble({ acceptAfter: 1 })
    const accountant = new WorkspaceAccountant(() => registry.registry, [1, 1], clock)
    accountant.track('code-session-1', '/repo')
    accountant.track('code-session-1', '/repo')
    accountant.track('code-session-1', '/repo')
    await clock.run()
    expect(registry.attempts).toBe(1)
  })

  it('does nothing for a directory that is not a workspace', async () => {
    const registry = registryDouble({ path: '/repo' })
    const accountant = new WorkspaceAccountant(() => registry.registry, [1], fakeClock())
    expect(await accountant.attachNow('code-session-1', '/elsewhere')).toBe(false)
    expect(registry.attempts).toBe(0)
  })

  it('treats an already accounted session as done without writing', async () => {
    const registry = registryDouble()
    const accountant = new WorkspaceAccountant(() => registry.registry, [1], fakeClock())
    expect(await accountant.attachNow('code-session-1', '/repo')).toBe(true)
    expect(registry.attempts).toBe(1)
    expect(await accountant.attachNow('code-session-1', '/repo')).toBe(true)
    // The second call read the account and stopped: attach is durable work.
    expect(registry.attempts).toBe(1)
  })

  it('does nothing in a composition with no workspace registry', async () => {
    const clock = fakeClock()
    const accountant = new WorkspaceAccountant(() => undefined, [1], clock)
    accountant.track('code-session-1', '/repo')
    await clock.run()
    expect(await accountant.attachNow('code-session-1', '/repo')).toBe(false)
  })

  it('waits for a registry that publishes after this plugin mounted', async () => {
    // The registry starts behind its own storage and persistence
    // dependencies, so the service is routinely absent at mount and present
    // by the first attempt. Reading it once would miss it for good.
    const clock = fakeClock()
    const registry = registryDouble()
    let published: WorkspaceRegistryFace | undefined
    const accountant = new WorkspaceAccountant(() => published, [1, 1], clock)
    accountant.track('code-session-1', '/repo')
    await clock.run()
    expect(registry.attached).toEqual([])
    published = registry.registry
    await clock.run()
    expect(registry.attached).toEqual(['code-session-1'])
  })

  it('drops every pending attempt when the plugin unloads', async () => {
    const clock = fakeClock()
    const registry = registryDouble({ acceptAfter: 99 })
    const accountant = new WorkspaceAccountant(() => registry.registry, [1, 1], clock)
    accountant.track('code-session-1', '/repo')
    accountant.dispose()
    await clock.run()
    expect(registry.attempts).toBe(0)
  })

  it('schedules a handful of widening attempts by default', () => {
    // A standing poll would cost the registry a session-header scan every
    // tick; the shipped schedule is short and finite on purpose.
    expect(ATTACH_SCHEDULE_MS.length).toBeLessThanOrEqual(6)
    expect([...ATTACH_SCHEDULE_MS]).toEqual([...ATTACH_SCHEDULE_MS].sort((a, b) => a - b))
  })

  it('survives a registry that throws instead of resolving', async () => {
    const registry: WorkspaceRegistryFace = {
      resolveByPath: () => Promise.reject(new Error('storage fault')),
    }
    const accountant = new WorkspaceAccountant(() => registry, [1], fakeClock())
    await expect(accountant.attachNow('code-session-1', '/repo')).resolves.toBe(false)
  })

  it('does not keep the host process alive for a pending attempt', () => {
    // The production clock unrefs; a spec can only check the seam exists.
    const unref = vi.fn()
    const accountant = new WorkspaceAccountant(() => registryDouble().registry, [1], {
      setTimeout: (callback, delayMs) => { unref(delayMs); return callback },
      clear: () => {},
    })
    accountant.track('code-session-1', '/repo')
    expect(unref).toHaveBeenCalledWith(1)
  })
})
