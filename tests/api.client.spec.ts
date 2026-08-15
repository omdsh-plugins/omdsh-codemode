// @vitest-environment jsdom
// The one call the column makes to its own host half: what a socket URL says
// about which conversation the surface wants.
import { describe, expect, it } from 'vitest'
import { terminalUrl } from '../src/client/api.ts'

/** The query of a built URL, as a plain record. */
function query(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams)
}

describe('terminalUrl', () => {
  it('names nothing when the surface has no conversation, leaving the answer to the host', () => {
    const url = terminalUrl({ sessionId: 'session-1', cwd: '/repo' }, 80, 24)
    expect(url.startsWith('ws://')).toBe(true)
    expect(query(url)).toEqual({ session: 'session-1', cwd: '/repo', cols: '80', rows: '24' })
  })

  it('names the conversation it is resuming', () => {
    const url = terminalUrl(
      { sessionId: 'code-session-a', cwd: '/repo', codeSessionId: 'code-session-a' },
      80,
      24,
    )
    expect(query(url).code).toBe('code-session-a')
    // Absent: a resume may be refused, because another process can be holding
    // that session — which is exactly what `fresh` says cannot be true.
    expect(query(url).fresh).toBeUndefined()
  })

  it('offers what to continue when this host has nothing running', () => {
    const url = terminalUrl(
      { sessionId: 'session-1', cwd: '/repo', resumeSessionId: 'code-session-recent' },
      80,
      24,
    )
    expect(query(url)).toMatchObject({ resume: 'code-session-recent' })
    // An offer is not a name: the host takes it only over minting a new one.
    expect(query(url).code).toBeUndefined()
  })

  it('drops the offer when a conversation IS named', () => {
    const url = terminalUrl(
      {
        sessionId: 'code-session-a',
        cwd: '/repo',
        codeSessionId: 'code-session-a',
        resumeSessionId: 'code-session-recent',
      },
      80,
      24,
    )
    expect(query(url).code).toBe('code-session-a')
    expect(query(url).resume).toBeUndefined()
  })

  it('says when the conversation is one it just minted', () => {
    const url = terminalUrl(
      { sessionId: 'code-session-b', cwd: '/repo', codeSessionId: 'code-session-b', fresh: true },
      80,
      24,
    )
    expect(query(url)).toMatchObject({ code: 'code-session-b', fresh: '1' })
  })
})
