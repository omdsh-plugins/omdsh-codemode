// Reading a terminal's own window title out of its output.
import { describe, expect, it } from 'vitest'
import { readOscTitle } from '../src/osc-title.ts'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

/** `OSC 0` with a BEL terminator: what the harness terminal writes. */
const title = (text: string): string => `${ESC}]0;${text}${BEL}`

describe('readOscTitle', () => {
  it('reads the title a terminal set', () => {
    expect(readOscTitle(title('Renamed — DeepSeek Harness'))).toBe('Renamed — DeepSeek Harness')
  })

  it('reads it out of ordinary output around it', () => {
    expect(readOscTitle(`hello\r\n${title('a name')}${ESC}[2m dim\r\n`)).toBe('a name')
  })

  it('takes the LAST one, because only the newest is true', () => {
    expect(readOscTitle(`${title('first')}${title('second')}`)).toBe('second')
  })

  it('accepts the window-title spelling as well as icon-and-title', () => {
    expect(readOscTitle(`${ESC}]2;window only${BEL}`)).toBe('window only')
  })

  it('accepts an ST terminator', () => {
    expect(readOscTitle(`${ESC}]0;via ST${ESC}\\`)).toBe('via ST')
  })

  it('says nothing about output with no announcement in it', () => {
    expect(readOscTitle('just a prompt ❯ ')).toBeUndefined()
    // Another OSC entirely: a hyperlink, which this must not read as a title.
    expect(readOscTitle(`${ESC}]8;;https://example.invalid${BEL}link`)).toBeUndefined()
  })

  it('waits for a sequence that has not finished arriving', () => {
    // A pty read can cut an escape sequence in half; the caller scans a tail
    // that grows, so the halves meet on a later read rather than here.
    expect(readOscTitle(`${ESC}]0;half a ti`)).toBeUndefined()
  })

  it('reads an empty title as the empty string rather than nothing', () => {
    expect(readOscTitle(title(''))).toBe('')
  })
})
