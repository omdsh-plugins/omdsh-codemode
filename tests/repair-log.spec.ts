// Reading a session log two processes wrote at once, and deciding what a
// repair would keep. Nothing here renumbers and nothing here invents.
import { describe, expect, it } from 'vitest'
import { readLineSpan, repairSessionLog } from '../src/repair-log.ts'

/** One ordinary event line. */
const event = (seq: number, type = 'user/message'): string => JSON.stringify({ type, seq, time: 0, data: {} })

/** A packed chunk row: one line standing for `count` events. */
const packed = (seq0: number, count: number): string => JSON.stringify({
  type: 'text-chunks',
  seq0,
  time0: 0,
  data: { index: 0, texts: Array.from({ length: count }, (_, at) => `t${String(at)}`), dt: [] },
})

const header = JSON.stringify({ session: { id: 'code-session-a', version: 1 } })

/** A log from its event lines. */
const log = (...lines: string[]): string => `${[header, ...lines].join('\n')}\n`

describe('readLineSpan', () => {
  it('reads an ordinary event as one', () => {
    expect(readLineSpan(event(7))).toEqual({ seq: 7, count: 1 })
  })

  it('reads a packed chunk row as the events it expands to', () => {
    // One line, several seqs: a naive reader counting lines would see holes
    // where the log is perfectly dense.
    expect(readLineSpan(packed(10, 4))).toEqual({ seq: 10, count: 4 })
  })

  it('says nothing about a header or an unparsable line', () => {
    expect(readLineSpan(header)).toBeUndefined()
    expect(readLineSpan('{ not json')).toBeUndefined()
  })
})

describe('repairSessionLog', () => {
  it('leaves a healthy log alone', () => {
    const repair = repairSessionLog(log(event(0), packed(1, 3), event(4)))
    expect(repair?.changed).toBe(false)
    expect(repair?.events).toBe(5)
    expect(repair?.dropped).toBe(0)
  })

  it('drops the line whose seq the file has already used', () => {
    // The shape two writers leave: each numbered its next event from its own
    // count, so one seq arrives twice. The interloper's line goes.
    const repair = repairSessionLog(log(event(0), event(1), event(1, 'session/end-seed'), event(2)))
    expect(repair?.dropped).toBe(1)
    expect(repair?.events).toBe(3)
    expect(repair?.lost).toBe(0)
    expect(repair?.lines).toEqual([event(0), event(1), event(2)])
  })

  it('stops at a hole, because the reader already does', () => {
    const repair = repairSessionLog(log(event(0), event(1), event(5), event(6)))
    expect(repair?.events).toBe(2)
    expect(repair?.lost).toBe(2)
    expect(repair?.changed).toBe(true)
  })

  it('counts what a packed row past the hole would have carried', () => {
    const repair = repairSessionLog(log(event(0), packed(9, 3)))
    expect(repair?.lost).toBe(3)
  })

  it('stops at a line it cannot read at all', () => {
    const repair = repairSessionLog(log(event(0), 'torn{', event(1)))
    expect(repair?.events).toBe(1)
    expect(repair?.lost).toBe(1)
  })

  it('keeps the header verbatim', () => {
    expect(repairSessionLog(log(event(0)))?.header).toBe(header)
  })

  it('has nothing to say about a file with no header line', () => {
    expect(repairSessionLog('')).toBeUndefined()
  })
})
