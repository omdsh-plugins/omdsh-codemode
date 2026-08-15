/**
 * What this plugin's host half refuses with. One error class carrying a
 * machine code, so the browser half can tell "start it again" from "stop
 * retrying and read this".
 * @module @omdsh-plugins/omdsh-code/src/wire
 */

/** Machine-routable failure kinds the browser half branches on. */
export type CodeErrorCode =
  /** The socket query is missing a parameter, or one of them is malformed. */
  | 'bad-request'
  /** No launcher to re-execute, and no configured command to use instead. */
  | 'no-launcher'
  /** The terminal could not be allocated. */
  | 'pty-error'

/** A refusal the socket closes with, verbatim. */
export class CodeError extends Error {
  /**
   * @param code - machine-routable kind.
   * @param message - human text; safe to show on the surface.
   */
  constructor(readonly code: CodeErrorCode, message: string) {
    super(message)
    this.name = 'CodeError'
  }
}

/**
 * The human text of any thrown value.
 * @param error - the thrown value.
 * @returns its message, or its string form.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
