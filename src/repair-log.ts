/**
 * Making a session log readable again after two processes wrote it.
 *
 * A session log is one JSON record per line, and every record's `seq` must be
 * exactly the number of events before it. Two live copies of one conversation
 * — a terminal and a web host that resumed the same session — each number
 * their next event from their own count, so the file ends up with a repeated
 * seq, and from that line on the reader stops trusting the file: it serves the
 * prefix, or refuses the session outright when a completed turn follows the
 * break. That refusal is what a person sees as "failed to start".
 *
 * This module answers one question about such a file: what would it look like
 * if the interloper's lines were never there? Two edits, both of them things
 * the reader already does to itself:
 *
 * - **Drop a line whose seq the file has already used.** It is the second
 *   writer's, it carries no conversation of its own (an `end-seed` marker, a
 *   start-up record), and removing it makes the numbering continue.
 * - **Stop at the first hole that remains.** Events after a gap are already
 *   unreachable — the reader stops there too — so cutting is a loss on paper
 *   only, and it turns "will not open" into "opens with what survived".
 *
 * Nothing is renumbered and nothing is invented: every line this keeps is a
 * line the original file had, at the seq it had.
 * @module @omdsh-plugins/omdsh-code/src/repair-log
 */

/** Chunk rows are one line that stands for several events. */
interface PackedRow {
  /** Seq of the first event the row expands to. */
  seq0?: number
  /** The members whose count decides how many events it expands to. */
  data?: { texts?: unknown[]; args?: unknown[] }
}

/** What one line of a log claims about the events it carries. */
export interface LogLineSpan {
  /** Seq of its first event. */
  seq: number
  /** How many events it stands for; more than one only for packed chunk rows. */
  count: number
}

/** What a repair would do to one log. */
export interface LogRepair {
  /** The header line, verbatim. */
  header: string
  /** The event lines to keep, in order, unchanged. */
  lines: string[]
  /** Lines dropped because the file had already used their seq. */
  dropped: number
  /** Events kept. */
  events: number
  /** Events the original file held past the first remaining hole. */
  lost: number
  /** Whether anything at all would change. */
  changed: boolean
}

/**
 * What one line stands for, or undefined when it is not an event record.
 * @param line - one JSON line of the log.
 * @returns its span, or undefined for the header and for unparsable lines.
 */
export function readLineSpan(line: string): LogLineSpan | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as { seq?: unknown; type?: unknown } & PackedRow
  if (typeof record.seq === 'number') return { seq: record.seq, count: 1 }
  // A packed chunk row: one line, several events, numbered from seq0.
  if (typeof record.seq0 !== 'number') return undefined
  const members = record.data?.texts ?? record.data?.args
  return { seq: record.seq0, count: Array.isArray(members) ? members.length : 1 }
}

/**
 * Read a log and decide what a repair would keep.
 * @param text - the decompressed log, header line first.
 * @returns the repair, or undefined when the text carries no header line.
 */
export function repairSessionLog(text: string): LogRepair | undefined {
  const all = text.split('\n').filter(line => line !== '')
  const header = all[0]
  if (header === undefined) return undefined
  const lines: string[] = []
  let next = 0
  let dropped = 0
  let lost = 0
  let cutting = false
  for (const line of all.slice(1)) {
    const span = readLineSpan(line)
    if (span === undefined) {
      // Not an event record — an unparsable line, which the reader stops at
      // as well. Treat the rest as lost.
      cutting = true
      continue
    }
    if (cutting) {
      lost += span.count
      continue
    }
    if (span.seq === next) {
      lines.push(line)
      next += span.count
      continue
    }
    // A seq the file has already used: the second writer's line.
    if (span.seq < next) {
      dropped += 1
      continue
    }
    // A hole. Everything past it is already unreachable.
    cutting = true
    lost += span.count
  }
  return { header, lines, dropped, events: next, lost, changed: dropped > 0 || lost > 0 }
}
