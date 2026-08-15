/**
 * Repair session logs two processes wrote at once.
 *
 * Reports by default and writes only when told to, because it edits
 * conversations. Every rewrite leaves the original beside it as `.bak`.
 *
 * ```sh
 * pnpm run repair:sessions                 # report on $DSH_HOME (or ~/.dsh)
 * pnpm run repair:sessions -- --write      # apply, keeping a .bak per log
 * pnpm run repair:sessions -- --home /path/to/dsh-home
 * ```
 *
 * See [repair-log](../src/repair-log.ts) for what "repair" means here: drop
 * the lines whose seq the file had already used, and stop at the first hole
 * that remains. Nothing is renumbered and nothing is invented.
 * @module @omdsh-plugins/omdsh-code/scripts/repair-session-logs
 */

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { repairSessionLog } from '../src/repair-log.ts'

/** The log file inside one session directory. */
const LOG_NAME = 'session.jsonl.zstd'

/**
 * Decompress a concatenated-frame zstd log.
 * @param bytes - the file's raw bytes.
 * @returns its text.
 */
function decompress(bytes: Buffer): string {
  // The backend appends one Zstandard frame per batch and Node's one-shot
  // decompressor stops at the first, so walk the frames. Their starts are
  // found by magic, and a magic that turns out to be compressed data instead
  // simply fails to decompress — so the split is retried at the next one.
  const MAGIC = 0xFD2FB528
  const starts: number[] = []
  for (let at = 0; at + 4 <= bytes.length; at++) {
    if (bytes.readUInt32LE(at) === MAGIC) starts.push(at)
  }
  const parts: string[] = []
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index] as number
    let decoded: Buffer | undefined
    for (let end = index + 1; end <= starts.length; end++) {
      try {
        decoded = zstdDecompressSync(bytes.subarray(start, starts[end] ?? bytes.length))
      } catch {
        continue
      }
      index = end - 1
      break
    }
    if (decoded === undefined) break
    parts.push(decoded.toString('utf8'))
  }
  return parts.join('')
}

/**
 * Every session directory under a home.
 * @param home - the `$DSH_HOME` to walk.
 * @returns absolute paths of session directories.
 */
function sessionDirs(home: string): string[] {
  const root = join(home, 'sessions')
  const found: string[] = []
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return found
  }
  for (const project of projects) {
    const projectDir = join(root, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const session of readdirSync(projectDir)) {
      const dir = join(projectDir, session)
      try {
        if (statSync(join(dir, LOG_NAME)).isFile()) found.push(dir)
      } catch {
        // Not a session directory; skip it.
      }
    }
  }
  return found
}

const args = process.argv.slice(2)
const write = args.includes('--write')
const homeFlag = args.indexOf('--home')
const home = homeFlag === -1
  ? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  : args[homeFlag + 1] ?? ''

let damaged = 0
for (const dir of sessionDirs(home)) {
  const path = join(dir, LOG_NAME)
  let repair
  try {
    repair = repairSessionLog(decompress(readFileSync(path)))
  } catch (error) {
    console.log(`skipped ${dir.split('/').pop() ?? dir}: cannot read (${String(error)})`)
    continue
  }
  if (repair === undefined || !repair.changed) continue
  damaged += 1
  const name = dir.split('/').pop() ?? dir
  console.log(
    `${name}: ${String(repair.dropped)} interleaved line(s) dropped, `
    + `${String(repair.events)} event(s) kept, ${String(repair.lost)} past the first hole lost`,
  )
  if (!write) continue
  // The container's first frame must hold exactly the header line — the
  // backend writes it that way and the reader checks it — so the header gets
  // its own frame and the events share the next.
  const head = zstdCompressSync(Buffer.from(`${repair.header}\n`, 'utf8'))
  const body = zstdCompressSync(Buffer.from(`${repair.lines.join('\n')}\n`, 'utf8'))
  renameSync(path, `${path}.bak`)
  writeFileSync(path, Buffer.concat([head, body]))
  console.log(`  written; the original is at ${LOG_NAME}.bak`)
}

console.log(damaged === 0
  ? `no damaged session logs under ${home}`
  : `${String(damaged)} damaged session log(s) under ${home}${write ? ' (repaired)' : ' — re-run with --write to repair'}`)
