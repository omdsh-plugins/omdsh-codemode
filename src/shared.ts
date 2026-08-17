/**
 * The contract between this plugin's two halves: the socket path, the query
 * it carries, and the terminal's control-frame codec.
 *
 * Node-free on purpose — the browser half imports this module for real, so a
 * single `node:` import here would put host code in the client bundle's module
 * graph.
 * @module @omdsh-plugins/omdsh-codemode/src/shared
 */

/** Path prefix every route of this plugin lives under. */
export const ROUTE_PREFIX = '/omdsh-codemode'

/** The terminal's WebSocket upgrade. */
export const TERMINAL_PATH = `${ROUTE_PREFIX}/terminal`

/**
 * Frames the browser half sends when it is not sending keystrokes.
 *
 * Server to client: raw terminal bytes as text. Client to server: raw text is
 * keystrokes, except a frame beginning with NUL, which is one of these. That
 * prefix is the whole reason the two are unambiguous — a user who types
 * `{"type":"resize"}` into the terminal must have it reach the terminal, and
 * no keyboard produces a leading NUL.
 */
export type TerminalControl =
  /** The column was resized; the pty grid follows. */
  | { type: 'resize'; cols: number; rows: number }
  /** The user ended this terminal outright; the process goes with it. */
  | { type: 'close' }

/**
 * Frames the host sends when it is not sending terminal output.
 *
 * One so far, and it exists because the browser cannot know the answer: which
 * session the terminal drives is decided host-side — an existing Code session
 * the surface asked to resume, or a freshly minted one — and the surface needs
 * it to know which conversation it is showing. Carrying it on the socket
 * rather than through a second request keeps it exact: it is the id of the
 * process on the other end of THIS socket, not whatever a later poll finds.
 */
export type TerminalNotice =
  /** The socket is now bridged to this Code session's terminal. */
  | { type: 'attached'; sessionId: string }

/** Byte that marks a frame as control rather than terminal traffic. */
export const CONTROL_PREFIX = '\u0000'

/**
 * Encode a control frame.
 * @param control - the message.
 * @returns the frame to send.
 */
export function encodeControl(control: TerminalControl): string {
  return CONTROL_PREFIX + JSON.stringify(control)
}

/**
 * Parse one client frame.
 * @param frame - the received text.
 * @returns the control message, or `undefined` when the frame is keystrokes
 * (including a malformed control frame, which is not worth ending a session over).
 */
export function decodeControl(frame: string): TerminalControl | undefined {
  if (!frame.startsWith(CONTROL_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.slice(CONTROL_PREFIX.length))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { type } = parsed as { type?: unknown }
  if (type === 'close') return { type: 'close' }
  if (type !== 'resize') return undefined
  const { cols, rows } = parsed as { cols?: unknown; rows?: unknown }
  if (typeof cols !== 'number' || typeof rows !== 'number') return undefined
  return { type: 'resize', cols, rows }
}

/**
 * Encode a host notice.
 * @param notice - the message.
 * @returns the frame to send.
 */
export function encodeNotice(notice: TerminalNotice): string {
  return CONTROL_PREFIX + JSON.stringify(notice)
}

/**
 * Parse one host frame.
 *
 * Same rule as {@link decodeControl} and for the same reason, read from the
 * other side: a terminal may legitimately emit a NUL, so anything that is not
 * a notice this version knows is terminal output and must reach the screen
 * verbatim rather than be swallowed as a malformed message.
 * @param frame - the received text.
 * @returns the notice, or `undefined` when the frame is terminal output.
 */
export function decodeNotice(frame: string): TerminalNotice | undefined {
  if (!frame.startsWith(CONTROL_PREFIX)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.slice(CONTROL_PREFIX.length))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { type, sessionId } = parsed as { type?: unknown; sessionId?: unknown }
  if (type !== 'attached' || typeof sessionId !== 'string' || sessionId === '') return undefined
  return { type: 'attached', sessionId }
}
