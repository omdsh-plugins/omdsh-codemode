// Making this process re-read a conversation a terminal renamed underneath it.
import { describe, expect, it } from 'vitest'
import { ProjectionRefolder, REFOLD_SCHEDULE_MS } from '../src/title-refold.ts'
import type { ProjectionCacheFace, RefoldClock } from '../src/title-refold.ts'

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
