// @vitest-environment jsdom
// The column's own markup: the centre-column marker the frame's overlay
// measures, and the states it shows before a terminal is live.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CodeSurface } from '../src/client/CodeSurface.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** English translate over this package's own dictionary. */
const t = ((key: string) => en[key as keyof typeof en] ?? key) as never

describe('CodeSurface', () => {
  it('wears the centre column\'s published marker, so the mode switch does not jump', () => {
    // The switch rides `shell.overlay` — a layer spanning the sidebar and the
    // details panel — and centres itself on the box carrying this attribute.
    // The conversation skeleton puts it on its scrollport; this column stands
    // in that same seat, so it has to carry it too or the switch loses its
    // anchor the instant Code mode takes the column and snaps to frame centre.
    const view = render(<CodeSurface scope={undefined} t={t} />)
    const anchors = view.container.querySelectorAll('[data-conversation-scroll]')
    expect(anchors).toHaveLength(1)
    // The marker belongs on the box that fills the seat, not on an inner one:
    // its centre is what the switch reads.
    expect(anchors[0]).toBe(view.container.firstElementChild)
  })

  it('says so rather than connecting when the conversation has no directory', () => {
    const view = render(<CodeSurface scope={undefined} t={t} />)
    expect(view.getByText(en['surface.noWorkspace'])).toBeTruthy()
    // No socket is attempted without a scope, so nothing here needs a stub.
    expect(view.container.querySelector('[data-conversation-scroll]')).toBeTruthy()
  })
})
