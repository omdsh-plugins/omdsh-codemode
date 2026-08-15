// The two-way frame format: keystrokes are raw, control frames are prefixed.
import { describe, expect, it } from 'vitest'
import {
  CONTROL_PREFIX, decodeControl, decodeNotice, encodeControl, encodeNotice, TERMINAL_PATH,
} from '../src/shared.ts'

describe('control frames', () => {
  it('round-trips a resize', () => {
    expect(decodeControl(encodeControl({ type: 'resize', cols: 120, rows: 40 })))
      .toEqual({ type: 'resize', cols: 120, rows: 40 })
  })

  it('round-trips a close', () => {
    expect(decodeControl(encodeControl({ type: 'close' }))).toEqual({ type: 'close' })
  })

  it('treats anything unprefixed as keystrokes, JSON included', () => {
    // A user typing this at the harness prompt must have it reach the agent.
    expect(decodeControl('{"type":"close"}')).toBeUndefined()
    expect(decodeControl('ls -la\r')).toBeUndefined()
  })

  it('treats a malformed control frame as keystrokes rather than as a close', () => {
    expect(decodeControl(`${CONTROL_PREFIX}not json`)).toBeUndefined()
    expect(decodeControl(`${CONTROL_PREFIX}null`)).toBeUndefined()
    expect(decodeControl(`${CONTROL_PREFIX}{"type":"resize"}`)).toBeUndefined()
    expect(decodeControl(`${CONTROL_PREFIX}{"type":"resize","cols":"80","rows":24}`)).toBeUndefined()
    expect(decodeControl(`${CONTROL_PREFIX}{"type":"other"}`)).toBeUndefined()
  })

  it('marks control frames with a byte no keyboard produces', () => {
    expect(CONTROL_PREFIX).toBe('\u0000')
  })
})

describe('host notices', () => {
  it('round-trips the session a terminal drives', () => {
    expect(decodeNotice(encodeNotice({ type: 'attached', sessionId: 'code-session-1' })))
      .toEqual({ type: 'attached', sessionId: 'code-session-1' })
  })

  it('treats anything else as terminal output, NUL included', () => {
    // A terminal may legitimately emit a NUL; swallowing that frame would take
    // real output off the screen.
    expect(decodeNotice('ready\r\n')).toBeUndefined()
    expect(decodeNotice(`${CONTROL_PREFIX}not json`)).toBeUndefined()
    expect(decodeNotice(`${CONTROL_PREFIX}{"type":"attached"}`)).toBeUndefined()
    expect(decodeNotice(`${CONTROL_PREFIX}{"type":"attached","sessionId":""}`)).toBeUndefined()
    expect(decodeNotice(`${CONTROL_PREFIX}{"type":"resize","cols":80,"rows":24}`)).toBeUndefined()
  })

  it('shares one control byte with the frames going the other way', () => {
    expect(encodeNotice({ type: 'attached', sessionId: 'x' }).startsWith(CONTROL_PREFIX)).toBe(true)
  })
})

describe('routes', () => {
  it('keeps every path under one prefix', () => {
    expect(TERMINAL_PATH.startsWith('/omdsh-code/')).toBe(true)
  })
})
