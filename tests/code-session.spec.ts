// The id that makes a session a Code session — the whole durable record.
import { describe, expect, it } from 'vitest'
import {
  chooseCodeSession, CODE_SESSION_PREFIX, isCodeSessionId, isResumeRequest, mintCodeSessionId,
} from '../src/code-session.ts'

describe('Code session ids', () => {
  it('mints a unique id under one prefix', () => {
    const first = mintCodeSessionId()
    const second = mintCodeSessionId()
    expect(first).toMatch(/^code-session-[0-9a-f-]{36}$/u)
    expect(first).not.toBe(second)
  })

  it('recognizes what it minted', () => {
    expect(isCodeSessionId(mintCodeSessionId())).toBe(true)
  })

  it('claims neither the web GUI\'s conversations nor the terminal\'s own', () => {
    // The two id shapes already on disk: `session-*` is what the web host
    // mints, `main-session-*` what `dsh --profile <name>` mints for itself.
    // Claiming either would put a red dot on a conversation this plugin never
    // started and could not bring back.
    expect(isCodeSessionId('session-4f0d2f3e-0b6d-4a4a-8c14-2a3d5e6f7a8b')).toBe(false)
    expect(isCodeSessionId('main-session-4f0d2f3e-0b6d-4a4a-8c14-2a3d5e6f7a8b')).toBe(false)
    expect(isCodeSessionId('')).toBe(false)
  })

  it('keeps the prefix a value both halves read', () => {
    expect(CODE_SESSION_PREFIX).toBe('code-session-')
    expect(mintCodeSessionId().startsWith(CODE_SESSION_PREFIX)).toBe(true)
  })
})

describe('what naming a conversation on a socket means', () => {
  it('is a resume when the surface reaches for one that already existed', () => {
    // A clicked Code row: that conversation may be held by another process,
    // and a terminal that could not take its session must never become the one
    // every later press of Code lands on.
    expect(isResumeRequest('code-session-a', false)).toBe(true)
  })

  it('is not a resume when the surface minted the id a moment ago', () => {
    // New Session in Code mode. Nobody can be holding it, and it IS this
    // directory's terminal from the moment it starts.
    expect(isResumeRequest('code-session-a', true)).toBe(false)
  })

  it('is not a resume when nothing was named at all', () => {
    expect(isResumeRequest(null, false)).toBe(false)
    expect(isResumeRequest('', false)).toBe(false)
  })
})

describe('which conversation a socket drives', () => {
  it('takes what the surface named', () => {
    expect(chooseCodeSession('code-session-named', 'code-session-live', 'code-session-offered'))
      .toBe('code-session-named')
  })

  it('takes this host\'s live terminal over the surface\'s offer', () => {
    // The offer is the project's most recent conversation ON DISK, and a
    // conversation started a moment ago has nothing there to be most recent —
    // so a browser that outranked the live table would revive an older one
    // over a running agent, and two live copies of one conversation interleave
    // their sequence numbers until the log stops loading.
    expect(chooseCodeSession(null, 'code-session-live', 'code-session-offered'))
      .toBe('code-session-live')
  })

  it('takes the offer when this host has nothing running here', () => {
    // Pressing Code after a restart: come back to the work, not to an empty
    // prompt.
    expect(chooseCodeSession(null, undefined, 'code-session-offered'))
      .toBe('code-session-offered')
  })

  it('asks for a new conversation when the project has none', () => {
    expect(chooseCodeSession(null, undefined, null)).toBeUndefined()
    expect(chooseCodeSession('', undefined, '')).toBeUndefined()
  })
})
