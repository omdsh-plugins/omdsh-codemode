// Keeping the sidebar's name for a Code conversation honest while a terminal
// renames it: what an announced window title costs, and when it stops costing.
import { describe, expect, it, vi } from 'vitest'
import { TerminalTitleSync, TITLE_REFRESH_SCHEDULE_MS } from '../src/client/title-sync.ts'
import type { TitleSyncClock } from '../src/client/title-sync.ts'

/** A clock a spec runs by hand, one scheduled callback at a time. */
function fakeClock() {
  const queue = new Map<number, () => void>()
  let next = 0
  const clock: TitleSyncClock = {
    setTimeout: (callback) => {
      const handle = next++
      queue.set(handle, callback)
      return handle
    },
    clear: (handle) => { queue.delete(handle as number) },
  }
  /** Run every callback scheduled so far, in order. */
  const tick = (): void => {
    const due = [...queue.entries()]
    queue.clear()
    for (const [, callback] of due) callback()
  }
  return { clock, tick, pending: () => queue.size }
}

/** The sync over a session list a spec can rewrite. */
function bench(listed: Record<string, string | undefined> = {}) {
  const { clock, tick, pending } = fakeClock()
  const refresh = vi.fn()
  const sync = new TerminalTitleSync(
    { listedTitle: sessionId => listed[sessionId], refresh },
    [1, 2, 3],
    clock,
  )
  return { sync, refresh, tick, pending, listed }
}

describe('a terminal announcing its title', () => {
  it('says nothing on the product greeting: that is the terminal saying hello', () => {
    // Every terminal states a title when it starts, and a reconnect replays
    // that write with the rest of the transcript. Entering Code mode must not
    // cost a session-list read.
    const b = bench()
    b.sync.announced('code-session-a', 'DeepSeek Harness')
    b.tick()
    expect(b.refresh).not.toHaveBeenCalled()
  })

  it('re-reads when the first announcement already names the conversation and the list has none', () => {
    // A pty read can deliver the greeting and the generated name together;
    // only the last is visible, and treating it as "first, therefore hello"
    // would leave the sidebar on the project basename.
    const b = bench()
    b.sync.announced('code-session-a', 'Unclear question — DeepSeek Harness')
    b.tick()
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it('says nothing on a reconnect that replays a name the list already has', () => {
    const b = bench({ 'code-session-a': 'Unclear question' })
    b.sync.announced('code-session-a', 'Unclear question — DeepSeek Harness')
    b.tick()
    expect(b.refresh).not.toHaveBeenCalled()
  })

  it('re-reads the session list when the title CHANGES', () => {
    const b = bench()
    b.sync.announced('code-session-a', 'proj — DeepSeek Harness')
    b.sync.announced('code-session-a', 'Renamed — DeepSeek Harness')
    b.tick()
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it('says nothing when the same title is announced again', () => {
    // Which is what a reconnect does: the replayed transcript carries the same
    // window-title write the surface already saw.
    const b = bench()
    b.sync.announced('code-session-a', 'a')
    b.sync.announced('code-session-a', 'b')
    for (let round = 0; round < 5; round++) b.tick()
    const spent = b.refresh.mock.calls.length
    b.sync.announced('code-session-a', 'b')
    expect(b.pending()).toBe(0)
    b.tick()
    expect(b.refresh).toHaveBeenCalledTimes(spent)
  })

  it('keeps looking until the row moves, and no longer', () => {
    // The rename is durable on the terminal's own timing — the projection
    // cache the host reads cold titles from is write-behind — so one pull can
    // legitimately read the old row.
    const b = bench({ 'code-session-a': 'old' })
    b.sync.announced('code-session-a', 'a')
    b.sync.announced('code-session-a', 'b')
    b.tick()
    expect(b.refresh).toHaveBeenCalledOnce()
    b.tick()
    expect(b.refresh).toHaveBeenCalledTimes(2)
    // The pull landed: the list says something else now.
    b.listed['code-session-a'] = 'new'
    b.tick()
    expect(b.refresh).toHaveBeenCalledTimes(2)
    expect(b.pending()).toBe(0)
  })

  it('gives up rather than polling forever', () => {
    const b = bench({ 'code-session-a': 'old' })
    b.sync.announced('code-session-a', 'a')
    b.sync.announced('code-session-a', 'b')
    for (let round = 0; round < 6; round++) b.tick()
    // One per scheduled attempt, and then nothing: a name that never settles
    // is a conversation nobody is waiting on.
    expect(b.refresh).toHaveBeenCalledTimes(3)
    expect(b.pending()).toBe(0)
  })

  it('replaces a run when the same conversation is renamed again', () => {
    const b = bench({ 'code-session-a': 'old' })
    b.sync.announced('code-session-a', 'a')
    b.sync.announced('code-session-a', 'b')
    b.sync.announced('code-session-a', 'c')
    expect(b.pending()).toBe(1)
    b.tick()
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it('keeps each conversation\'s run apart', () => {
    const b = bench()
    b.sync.announced('code-session-a', 'a1')
    b.sync.announced('code-session-b', 'b1')
    b.sync.announced('code-session-a', 'a2')
    expect(b.pending()).toBe(1)
    b.tick()
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it('stops everything when the plugin goes away', () => {
    const b = bench({ 'code-session-a': 'old' })
    b.sync.announced('code-session-a', 'a')
    b.sync.announced('code-session-a', 'b')
    b.sync.dispose()
    b.tick()
    expect(b.refresh).not.toHaveBeenCalled()
    b.sync.announced('code-session-a', 'c')
    b.tick()
    expect(b.refresh).not.toHaveBeenCalled()
  })

  it('widens its attempts rather than standing on a poll', () => {
    expect([...TITLE_REFRESH_SCHEDULE_MS]).toEqual([1_000, 6_000, 15_000])
    expect(TITLE_REFRESH_SCHEDULE_MS.every((delay, index, all) =>
      index === 0 || delay > (all[index - 1] as number))).toBe(true)
  })

  it('re-reads a conversation the list still has no title for', () => {
    const b = bench()
    b.sync.catchUp('code-session-a')
    b.tick()
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it('does not re-read a conversation the list already named', () => {
    const b = bench({ 'code-session-a': 'Greeting' })
    b.sync.catchUp('code-session-a')
    b.tick()
    expect(b.refresh).not.toHaveBeenCalled()
  })
})
