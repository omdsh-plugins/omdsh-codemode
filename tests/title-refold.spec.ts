// Making this process re-read a conversation a terminal renamed underneath it.
import { describe, expect, it } from 'vitest'
import {
  catchUpUntitled, projectionCacheFromHost, ProjectionRefolder, REFOLD_SCHEDULE_MS,
} from '../src/title-refold.ts'
import type {
  HostProjectionCacheFace, ProjectionCacheFace, RefoldClock, SessionInspectionFace,
} from '../src/title-refold.ts'

/** A clock a spec runs by hand. */
function fakeClock() {
  const queue = new Map<number, () => void>()
  let next = 0
  const clock: RefoldClock = {
    setTimeout: (callback) => {
      const handle = next++
      queue.set(handle, callback)
      return handle
    },
    clear: (handle) => { queue.delete(handle as number) },
  }
  /** Run everything scheduled so far, then let the pending folds settle. */
  const tick = async (): Promise<void> => {
    const due = [...queue.values()]
    queue.clear()
    for (const callback of due) callback()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { clock, tick, pending: () => queue.size }
}

/** A refolder over a cache whose answers a spec sets; `reject` stands for a fault. */
function bench(titles: readonly (string | undefined)[] | 'reject') {
  const { clock, tick, pending } = fakeClock()
  const reads: string[] = []
  const cache: ProjectionCacheFace = {
    coldSnapshot: async (sessionId) => {
      reads.push(sessionId)
      if (titles === 'reject') throw new Error('not found')
      const title = titles[reads.length - 1]
      return { asOfSeq: reads.length, values: title === undefined ? {} : { title } }
    },
  }
  const refolder = new ProjectionRefolder(() => cache, [1, 2, 3], clock)
  return { refolder, reads, tick, pending }
}

describe('a conversation renamed in a terminal', () => {
  it('is re-read, so this process stops serving the name it booted with', async () => {
    const b = bench(['old', 'new'])
    b.refolder.renamed('code-session-a')
    await b.tick()
    expect(b.reads).toEqual(['code-session-a'])
  })

  it('is re-read again until the folded name moves', async () => {
    // The terminal makes a rename durable on its own timing — the log flush
    // and the cache write are write-behind — so the first read can rightly
    // still see the old name.
    const b = bench(['old', 'old', 'new'])
    b.refolder.renamed('code-session-a')
    await b.tick()
    await b.tick()
    expect(b.reads).toHaveLength(2)
    await b.tick()
    expect(b.reads).toHaveLength(3)
    // It moved: nothing left to wait for.
    await b.tick()
    expect(b.reads).toHaveLength(3)
    expect(b.pending()).toBe(0)
  })

  it('gives up rather than reading forever', async () => {
    const b = bench(['same', 'same', 'same', 'same'])
    b.refolder.renamed('code-session-a')
    for (let round = 0; round < 6; round++) await b.tick()
    expect(b.reads).toHaveLength(3)
    expect(b.pending()).toBe(0)
  })

  it('replaces a run when the same conversation is renamed again', async () => {
    const b = bench(['old', 'old', 'old', 'old'])
    b.refolder.renamed('code-session-a')
    b.refolder.renamed('code-session-a')
    expect(b.pending()).toBe(1)
    await b.tick()
    expect(b.reads).toHaveLength(1)
  })

  it('survives a cache that rejects: a terminal nobody typed into has no log', async () => {
    const b = bench('reject')
    b.refolder.renamed('code-session-a')
    await expect(b.tick()).resolves.toBeUndefined()
  })

  it('does nothing at all in a composition with no projection cache', async () => {
    const { clock, tick } = fakeClock()
    const refolder = new ProjectionRefolder(() => undefined, [1, 2], clock)
    refolder.renamed('code-session-a')
    await expect(tick()).resolves.toBeUndefined()
  })

  it('stops every pending read when the plugin unloads', async () => {
    const b = bench(['old', 'old'])
    b.refolder.renamed('code-session-a')
    b.refolder.dispose()
    await b.tick()
    expect(b.reads).toHaveLength(0)
    b.refolder.renamed('code-session-a')
    expect(b.pending()).toBe(0)
  })

  it('reads ahead of the browser half, so each list it pulls is already fresh', () => {
    expect([...REFOLD_SCHEDULE_MS]).toEqual([500, 3_000, 8_000])
  })
})

describe('projectionCacheFromHost', () => {
  it('inspects the log and asks the host cache to fold it', async () => {
    const folds: Array<{ id: string; inherited: number; events: readonly unknown[] }> = []
    const persist: SessionInspectionFace = {
      inspect: async (id) => ({
        meta: { id, createdAt: 1, isSeeded: false },
        inheritedEventCount: 0,
        events: [{ type: 'session/title' }],
      }),
    }
    const host: HostProjectionCacheFace = {
      cachedSnapshot: () => undefined,
      coldSnapshot: (meta, inherited, events) => {
        folds.push({ id: meta.id, inherited, events })
        return { asOfSeq: 1, values: { title: 'Renamed' } }
      },
    }
    const cache = projectionCacheFromHost(() => host, () => persist)()
    const snap = await cache!.coldSnapshot('code-session-a')
    expect(snap.values.title).toBe('Renamed')
    expect(folds).toEqual([{
      id: 'code-session-a', inherited: 0, events: [{ type: 'session/title' }],
    }])
  })

  it('is off while either service is unpublished', () => {
    const persist: SessionInspectionFace = {
      inspect: async () => ({ meta: { id: 'x', createdAt: 1, isSeeded: false }, inheritedEventCount: 0, events: [] }),
    }
    const host: HostProjectionCacheFace = {
      cachedSnapshot: () => undefined,
      coldSnapshot: () => ({ asOfSeq: 0, values: {} }),
    }
    expect(projectionCacheFromHost(() => undefined, () => persist)()).toBeUndefined()
    expect(projectionCacheFromHost(() => host, () => undefined)()).toBeUndefined()
  })
})

describe('catchUpUntitled', () => {
  const meta = { id: 'code-session-a', createdAt: 1, isSeeded: false }
  const persist: SessionInspectionFace = {
    inspect: async () => ({ meta, inheritedEventCount: 0, events: [{ type: 'session/title' }] }),
  }

  it('skips a conversation this process already has a title for', async () => {
    let folded = 0
    const host: HostProjectionCacheFace = {
      cachedSnapshot: () => ({ asOfSeq: 1, values: { title: 'Greeting' } }),
      coldSnapshot: () => {
        folded++
        return { asOfSeq: 1, values: { title: 'Greeting' } }
      },
    }
    expect(await catchUpUntitled(host, persist, 'code-session-a')).toBe(false)
    expect(folded).toBe(0)
  })

  it('folds a conversation whose cache row has no title', async () => {
    let folded = 0
    const host: HostProjectionCacheFace = {
      cachedSnapshot: () => ({ asOfSeq: 0, values: {} }),
      coldSnapshot: () => {
        folded++
        return { asOfSeq: 1, values: { title: 'Unclear question' } }
      },
    }
    expect(await catchUpUntitled(host, persist, 'code-session-a')).toBe(true)
    expect(folded).toBe(1)
  })

  it('survives a missing log', async () => {
    const host: HostProjectionCacheFace = {
      cachedSnapshot: () => undefined,
      coldSnapshot: () => ({ asOfSeq: 0, values: {} }),
    }
    expect(await catchUpUntitled(host, {
      inspect: async () => { throw new Error('not found') },
    }, 'code-session-a')).toBe(false)
  })
})
