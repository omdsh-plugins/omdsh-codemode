/**
 * The wire between one browser surface and one harness terminal: transcript
 * replay, then relay in both directions until either end goes away. The frame
 * format lives in [shared](./shared.ts), because the browser half must produce
 * exactly what this module parses.
 * @module @omdsh-plugins/omdsh-codemode/src/terminal-socket
 */

import type { WebSocket } from 'ws'
import type { CodeTerminal, HarnessTerminalRegistry } from './harness-pty.ts'
import { clampDimension } from './harness-pty.ts'
import { decodeControl, encodeNotice } from './shared.ts'

/** What the surface prints in place of a terminal that is no longer there. */
const EXITED_NOTICE = '\r\n\u001b[2m[the harness terminal exited]\u001b[0m\r\n'

/** What the bridge tells its owner about this terminal's life. */
export interface BridgeHooks {
  /**
   * The terminal ended — the user exited it, or the process died. Whatever it
   * wrote is as written as it will ever be, which is the owner's last chance
   * to account for the session.
   */
  onEnd?: () => void
}

/**
 * Bridge one accepted socket to one terminal.
 * @param socket - the accepted WebSocket.
 * @param terminal - the attached terminal.
 * @param registry - the table, for the lifetime decisions on disconnect.
 * @param hooks - see {@link BridgeHooks}.
 */
export function bridge(
  socket: WebSocket,
  terminal: CodeTerminal,
  registry: HarnessTerminalRegistry,
  hooks: BridgeHooks = {},
): void {
  const send = (text: string): void => {
    if (socket.readyState === socket.OPEN) socket.send(text)
  }
  // Before any output: the surface has to know which conversation this
  // terminal drives, and that was decided here — a resumed Code session, or a
  // freshly minted one — rather than by the browser that asked.
  send(encodeNotice({ type: 'attached', sessionId: terminal.sessionId }))
  // History first, live output after — the surface then reads as one
  // continuous session across a refresh instead of resuming mid-frame.
  if (terminal.transcript !== '') send(terminal.transcript)
  // A socket that attaches to an already-dead terminal must say so rather
  // than present a live-looking prompt that swallows every keystroke.
  if (terminal.exited) send(EXITED_NOTICE)

  const output = terminal.pty.onData(send)
  const exit = terminal.pty.onExit(() => {
    send(EXITED_NOTICE)
    hooks.onEnd?.()
  })

  socket.on('message', (data: unknown, isBinary: boolean) => {
    if (isBinary) return
    const frame = String(data)
    const control = decodeControl(frame)
    if (control === undefined) {
      terminal.pty.write(frame)
      return
    }
    if (control.type === 'resize') {
      try {
        terminal.pty.resize(clampDimension(control.cols), clampDimension(control.rows))
      } catch {
        // The process exited between the frame and this call; the exit notice
        // above is what the user sees.
      }
      return
    }
    // An explicit close ends the terminal now and releases the session's slot.
    registry.close(terminal.sessionId)
    hooks.onEnd?.()
  })

  socket.on('close', () => {
    output.dispose()
    exit.dispose()
    // A bare drop is a refresh, a mode switch, or a conversation change — none
    // of them mean "kill my agent mid-turn". The grace is what makes coming
    // back land on the same process.
    registry.scheduleClose(terminal.sessionId)
  })
}
