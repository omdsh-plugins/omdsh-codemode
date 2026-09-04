// Getting a Code conversation out of Ungrouped and into its workspace group —
// once it has BEGUN, and not before: a turn-less conversation left in a
// workspace account is what the frame reuses for New Session, which puts a
// terminal back on screen in whatever mode the user pressed it in.
import { describe, expect, it, vi } from 'vitest'
import {
  ATTACH_SCHEDULE_MS, conversationBegunFromLog, logShowsTurn, RECONCILE_SCHEDULE_MS,
  WorkspaceAccountant,
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

/** The probe, as a spec drives it: begun after `beginsAfter` questions. */
function begunDouble(options: { beginsAfter?: number; answer?: boolean | undefined } = {}) {
  let asked = 0
  return {
    get asked() {
      return asked
    },
    probe: async (_sessionId: string) => {
      asked++
      if (options.beginsAfter === undefined) return options.answer
      return asked > options.beginsAfter
    },
  }
}

/** A registry with one workspace, whose account a spec can seed and read. */
function registryDouble(options: { path?: string; accounted?: string[] } = {}) {
  const path = options.path ?? '/repo'
  const attached: string[] = [...options.accounted ?? []]
  let attaches = 0
  let detaches = 0
  const workspace: WorkspaceFace = {
    get sessionIds() {
      return [...attached]
    },
    attachSession: async (sessionId: string) => {
      attaches++
      attached.push(sessionId)
    },
    detachSession: async (sessionId: string) => {
      detaches++
      const at = attached.indexOf(sessionId)
      if (at >= 0) attached.splice(at, 1)
    },
  }
  const registry: WorkspaceRegistryFace = {
    resolveByPath: async (asked: string) => (asked === path ? workspace : undefined),
    list: () => [workspace],
  }
  return {
    registry, workspace, attached,
    get attaches() { return attaches },
    get detaches() { return detaches },
  }
}

describe('WorkspaceAccountant', () => {
  it('accounts for a Code conversation once a turn has run in it', async () => {
    const clock = fakeClock()
    const registry = registryDouble()
    const begun = begunDouble({ beginsAfter: 2 })
    const accountant = new WorkspaceAccountant(() => registry.registry, begun.probe, [1, 1, 1, 1], clock)
    accountant.track('code-session-1', '/repo')

    await clock.run()
    expect(registry.attached).toEqual([])
    await clock.run()
    expect(registry.attached).toEqual([])
    await clock.run()
    // The third attempt is the first one after the conversation began.
    expect(registry.attached).toEqual(['code-session-1'])
  })

  it('never accounts for one that has a log but no turn', async () => {
    // The whole bug: `dsh` writes a session header when the terminal starts, so
    // a terminal nobody typed into leaves a real, tiny, BLANK log. Accounting
    // it hands it to the frame's New Session — which reuses a workspace's blank
    // conversation — and the next New Session in Chat or Work opens a terminal.
    const clock = fakeClock()
    const registry = registryDouble()
    const accountant = new WorkspaceAccountant(
      () => registry.registry, begunDouble({ answer: false }).probe, [1, 1, 1], clock,
    )
    accountant.track('code-session-1', '/repo')
    await clock.run()
    await clock.run()
    await clock.run()
    expect(registry.attached).toEqual([])
    expect(registry.attaches).toBe(0)
  })

  it('takes back an account an earlier build left on an unbegun conversation', async () => {
    const registry = registryDouble({ accounted: ['code-session-1'] })
    const accountant = new WorkspaceAccountant(
      () => registry.registry, begunDouble({ answer: false }).probe, [1], fakeClock(),
    )
    expect(await accountant.settleNow('code-session-1', '/repo')).toBe(false)
    expect(registry.attached).toEqual([])
    expect(registry.detaches).toBe(1)
  })

  it('leaves the account exactly as it is when it cannot tell', async () => {
    // No projection composed, no log yet, a storage fault: all the same answer,
    // and none of them is a reason to write anything either way.
    const accounted = registryDouble({ accounted: ['code-session-1'] })
    const empty = registryDouble()
    const unanswerable = begunDouble({ answer: undefined }).probe
    const keeping = new WorkspaceAccountant(() => accounted.registry, unanswerable, [1], fakeClock())
    const adding = new WorkspaceAccountant(() => empty.registry, unanswerable, [1], fakeClock())

    expect(await keeping.settleNow('code-session-1', '/repo')).toBe(true)
    expect(accounted.detaches).toBe(0)
    expect(await adding.settleNow('code-session-1', '/repo')).toBe(false)
    expect(empty.attaches).toBe(0)
  })

  it('stops once it lands, rather than re-attaching forever', async () => {
    const clock = fakeClock()
    const registry = registryDouble()
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => registry.registry, begun.probe, [1, 1, 1], clock)
    accountant.track('code-session-1', '/repo')
    await clock.run()
    await clock.run()
    expect(registry.attaches).toBe(1)
  })

  it('settles on a direct call, so the row does not wait for the next attempt', async () => {
    // What a terminal renaming its window buys: the name is generated from the
    // first turn, so the host knows the conversation began at that moment
    // rather than up to a minute and a half later.
    const clock = fakeClock()
    const registry = registryDouble()
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => registry.registry, begun.probe, [90_000], clock)
    accountant.track('code-session-1', '/repo')
    expect(await accountant.settleNow('code-session-1', '/repo')).toBe(true)
    expect(registry.attached).toEqual(['code-session-1'])
    // And the attempt that was still armed for it does not wake up to ask a
    // question that has been answered.
    await clock.run()
    expect(begun.asked).toBe(1)
    expect(registry.attaches).toBe(1)
  })

  it('costs nothing to track a conversation that already settled', async () => {
    const clock = fakeClock()
    const registry = registryDouble()
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => registry.registry, begun.probe, [1], clock)
    await accountant.settleNow('code-session-1', '/repo')
    accountant.track('code-session-1', '/repo')
    expect(clock.pending).toBe(0)
  })

  it('gives up quietly when the schedule runs out', async () => {
    const clock = fakeClock()
    const registry = registryDouble()
    const accountant = new WorkspaceAccountant(
      () => registry.registry, begunDouble({ answer: false }).probe, [1, 1], clock,
    )
    accountant.track('code-session-1', '/repo')
    await clock.run()
    await clock.run()
    await clock.run()
    // Two attempts, no third schedule, and no throw: a terminal nobody typed
    // into leaves no row, which is the intended outcome and not an error.
    expect(registry.attaches).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('re-arms the schedule when the terminal is opened again', async () => {
    // A second socket for the same conversation is the user back in that
    // terminal and about to type in it. The schedule that ran out while they
    // were away is exactly the one worth running again.
    const clock = fakeClock()
    const registry = registryDouble()
    const begun = begunDouble({ beginsAfter: 1 })
    const accountant = new WorkspaceAccountant(() => registry.registry, begun.probe, [1], clock)
    accountant.track('code-session-1', '/repo')
    await clock.run()
    expect(registry.attached).toEqual([])

    accountant.track('code-session-1', '/repo')
    await clock.run()
    expect(registry.attached).toEqual(['code-session-1'])
  })

  it('runs one schedule at a time however often it is tracked', async () => {
    const clock = fakeClock()
    const registry = registryDouble()
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => registry.registry, begun.probe, [1, 1], clock)
    accountant.track('code-session-1', '/repo')
    accountant.track('code-session-1', '/repo')
    accountant.track('code-session-1', '/repo')
    await clock.run()
    expect(begun.asked).toBe(1)
    expect(registry.attaches).toBe(1)
  })

  it('does nothing for a directory that is not a workspace', async () => {
    const registry = registryDouble({ path: '/repo' })
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => registry.registry, begun.probe, [1], fakeClock())
    expect(await accountant.settleNow('code-session-1', '/elsewhere')).toBe(false)
    expect(begun.asked).toBe(0)
    expect(registry.attaches).toBe(0)
  })

  it('treats an already accounted begun session as done without writing', async () => {
    const registry = registryDouble()
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => registry.registry, begun.probe, [1], fakeClock())
    expect(await accountant.settleNow('code-session-1', '/repo')).toBe(true)
    expect(registry.attaches).toBe(1)
    expect(await accountant.settleNow('code-session-1', '/repo')).toBe(true)
    // The second call read the account and stopped: attach is durable work.
    expect(registry.attaches).toBe(1)
  })

  it('does nothing in a composition with no workspace registry', async () => {
    const clock = fakeClock()
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => undefined, begun.probe, [1], clock)
    accountant.track('code-session-1', '/repo')
    await clock.run()
    expect(await accountant.settleNow('code-session-1', '/repo')).toBe(false)
  })

  it('waits for a registry that publishes after this plugin mounted', async () => {
    // The registry starts behind its own storage and persistence
    // dependencies, so the service is routinely absent at mount and present
    // by the first attempt. Reading it once would miss it for good.
    const clock = fakeClock()
    const registry = registryDouble()
    let published: WorkspaceRegistryFace | undefined
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => published, begun.probe, [1, 1], clock)
    accountant.track('code-session-1', '/repo')
    await clock.run()
    expect(registry.attached).toEqual([])
    published = registry.registry
    await clock.run()
    expect(registry.attached).toEqual(['code-session-1'])
  })

  it('drops every pending attempt when the plugin unloads', async () => {
    const clock = fakeClock()
    const registry = registryDouble()
    const begun = begunDouble({ answer: false })
    const accountant = new WorkspaceAccountant(() => registry.registry, begun.probe, [1, 1], clock)
    accountant.track('code-session-1', '/repo')
    accountant.dispose()
    await clock.run()
    expect(begun.asked).toBe(0)
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
      list: () => [],
    }
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => registry, begun.probe, [1], fakeClock())
    await expect(accountant.settleNow('code-session-1', '/repo')).resolves.toBe(false)
  })

  it('does not keep the host process alive for a pending attempt', () => {
    // The production clock unrefs; a spec can only check the seam exists.
    const unref = vi.fn()
    const begun = begunDouble({ answer: true })
    const accountant = new WorkspaceAccountant(() => registryDouble().registry, begun.probe, [1], {
      setTimeout: (callback: () => void, delayMs: number) => { unref(delayMs); return callback },
      clear: () => {},
    })
    accountant.track('code-session-1', '/repo')
    expect(unref).toHaveBeenCalledWith(1)
  })

  describe('the one-time sweep', () => {
    it('unaccounts every Code conversation that never began', async () => {
      const registry = registryDouble({
        accounted: ['code-session-1', 'session-2', 'code-session-3'],
      })
      const accountant = new WorkspaceAccountant(
        () => registry.registry,
        async (sessionId: string) => sessionId === 'code-session-3',
        [1],
        fakeClock(),
      )
      await accountant.reconcileAccounts()
      // The begun terminal keeps its group, and the web conversation was never
      // this plugin's to judge — it is another mode's, blank or not.
      expect(registry.attached).toEqual(['session-2', 'code-session-3'])
    })

    it('leaves an account alone when the answer is unavailable', async () => {
      const registry = registryDouble({ accounted: ['code-session-1'] })
      const accountant = new WorkspaceAccountant(
        () => registry.registry, begunDouble({ answer: undefined }).probe, [1], fakeClock(),
      )
      await accountant.reconcileAccounts()
      expect(registry.attached).toEqual(['code-session-1'])
    })

    it('carries on past one conversation it cannot read', async () => {
      const registry = registryDouble({ accounted: ['code-session-1', 'code-session-2'] })
      const accountant = new WorkspaceAccountant(
        () => registry.registry,
        async (sessionId: string) => {
          if (sessionId === 'code-session-1') throw new Error('unreadable log')
          return false
        },
        [1],
        fakeClock(),
      )
      await accountant.reconcileAccounts()
      expect(registry.attached).toEqual(['code-session-1'])
    })

    it('waits for the registry, then runs once', async () => {
      const clock = fakeClock()
      const registry = registryDouble({ accounted: ['code-session-1'] })
      let published: WorkspaceRegistryFace | undefined
      const accountant = new WorkspaceAccountant(
        () => published, begunDouble({ answer: false }).probe, [1], clock,
      )
      accountant.reconcileSoon([1, 1, 1])
      await clock.run()
      expect(registry.attached).toEqual(['code-session-1'])

      published = registry.registry
      await clock.run()
      expect(registry.attached).toEqual([])
      // Found one, so nothing is left scheduled: the sweep is about accounts
      // written before this build, and those do not keep arriving.
      expect(clock.pending).toBe(0)
    })

    it('starts early, because the frame opens a workspace on its own', () => {
      // The frame's initial workspace selection reuses a blank conversation as
      // soon as a page connects, so a sweep that waited would be a page that
      // opened in a terminal.
      expect(RECONCILE_SCHEDULE_MS[0]).toBeLessThanOrEqual(1_000)
      expect([...RECONCILE_SCHEDULE_MS]).toEqual([...RECONCILE_SCHEDULE_MS].sort((a, b) => a - b))
    })

    it('accounts for a begun Code conversation nobody attached', async () => {
      // The whole bug this sweep now also undoes: the terminal wrote a real
      // conversation, the sidebar listed it, and it sat in Ungrouped because
      // the probe that was supposed to attach it could never answer.
      const registry = registryDouble()
      const accountant = new WorkspaceAccountant(
        () => registry.registry,
        begunDouble({ answer: true }).probe,
        { catalog: () => ({ list: async () => [{ id: 'code-session-1', cwd: '/repo' }] }) },
      )
      await accountant.reconcileAccounts()
      expect(registry.attached).toEqual(['code-session-1'])
    })

    it('does not claim a web conversation, or one in no project', async () => {
      const registry = registryDouble()
      const accountant = new WorkspaceAccountant(
        () => registry.registry,
        begunDouble({ answer: true }).probe,
        {
          catalog: () => ({
            list: async () => [
              { id: 'session-web', cwd: '/repo' },
              { id: 'code-session-1', cwd: '/elsewhere' },
            ],
          }),
        },
      )
      await accountant.reconcileAccounts()
      expect(registry.attaches).toBe(0)
    })
  })

  it('attaches on a known beginning even when the probe cannot answer', async () => {
    // A terminal renaming its window is the turn; the log the other process
    // is still flushing is why inspect may reject in that same moment.
    const registry = registryDouble()
    const accountant = new WorkspaceAccountant(
      () => registry.registry, begunDouble({ answer: undefined }).probe, [1], fakeClock(),
    )
    expect(await accountant.settleNow('code-session-1', '/repo')).toBe(false)
    expect(await accountant.settleNow('code-session-1', '/repo', true)).toBe(true)
    expect(registry.attached).toEqual(['code-session-1'])
  })
})

describe('logShowsTurn', () => {
  it('is true once a turn has started or ended', () => {
    expect(logShowsTurn([{ type: 'session' }, { type: 'turn/start' }])).toBe(true)
    expect(logShowsTurn([{ type: 'turn/end' }])).toBe(true)
  })

  it('is false for a header-only terminal log', () => {
    expect(logShowsTurn([
      { type: 'session' },
      { type: 'permission/preset' },
      { type: 'sandbox/mode' },
      { type: 'approval/policy' },
    ])).toBe(false)
  })
})

describe('conversationBegunFromLog', () => {
  it('reads the log, and treats a missing one as unanswerable', async () => {
    const probe = conversationBegunFromLog(async (sessionId) => {
      if (sessionId === 'missing') throw new Error('no log')
      return sessionId === 'begun' ? [{ type: 'turn/start' }] : [{ type: 'session' }]
    })
    expect(await probe('begun')).toBe(true)
    expect(await probe('blank')).toBe(false)
    expect(await probe('missing')).toBeUndefined()
  })
})
