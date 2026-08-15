/**
 * The embedded terminal's colors, taken from the app's own theme.
 *
 * xterm paints on a canvas, so it cannot inherit anything from CSS: its
 * surface colors have to be READ out of the resolved tokens and handed over as
 * values, and re-read whenever the app's scheme flips. The sixteen ANSI colors
 * are not tokens at all — no design system defines them — so they are two
 * curated palettes chosen to sit correctly on each scheme's background.
 * @module @omdsh-plugins/omdsh-code/src/client/theme
 */

import type { ITheme } from 'xterm'

/**
 * Body attribute the harness's theme presenter sets for its dark palette. It
 * also writes the active theme's alias tokens as inline variables on the same
 * element, which is why every read below is taken from `document.body`: the
 * root alone would miss whatever the active theme overrode.
 */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** The resolved value of one CSS custom property, as the app paints it. */
function tokenValue(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim()
}

/** Whether the app is currently painting its dark scheme. */
export function isDarkScheme(): boolean {
  if (document.body.hasAttribute(DARK_ATTRIBUTE)) return true
  const scheme = document.documentElement.style.colorScheme.trim()
  if (scheme === 'light') return false
  if (scheme === 'dark') return true
  // No theme presenter on the page (a stripped test host): the system
  // preference is the only signal left.
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** One-dark family, for dark backgrounds. */
const ANSI_DARK = {
  black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
  brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
  brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
  brightCyan: '#56b6c2', brightWhite: '#ffffff',
} as const

/** One-light family, for light backgrounds. */
const ANSI_LIGHT = {
  black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
  blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#a0a1a7',
  brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f',
  brightYellow: '#c18401', brightBlue: '#0184bc', brightMagenta: '#a626a4',
  brightCyan: '#0997b3', brightWhite: '#fafafa',
} as const

/**
 * The xterm theme for the scheme the app is painting right now.
 * @returns surface colors from the theme tokens, ANSI colors curated.
 */
export function terminalTheme(): ITheme {
  const dark = isDarkScheme()
  const background = tokenValue('--dsw-alias-bg-base') || (dark ? '#111114' : '#ffffff')
  const foreground = tokenValue('--dsw-alias-label-primary') || (dark ? '#e6e6e6' : '#1a1a1a')
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)',
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  }
}

/**
 * The terminal's font, from the app's code-font token.
 * @returns family and size for the xterm grid.
 */
export function terminalFont(): { fontFamily: string; fontSize: number } {
  const family = tokenValue('--ds-font-family-code')
  return {
    fontFamily: family === '' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : family,
    // A column-filling surface, not a docked strip: the terminal is the
    // reading surface here, so it takes the app's ordinary body size.
    fontSize: 13,
  }
}

/**
 * Watch for a scheme flip.
 *
 * The app writes its theme onto the document element, and the system scheme
 * can move under an "auto" preference, so both are watched: one observer on
 * the root's attributes, one media-query listener.
 * @param onChange - called after each flip; re-read the theme inside it.
 * @returns the unsubscribe.
 */
export function subscribeColorScheme(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (): void => { onChange() }
  media.addEventListener('change', handler)
  const observer = new MutationObserver(handler)
  observer.observe(document.documentElement, { attributes: true })
  observer.observe(document.body, { attributes: true })
  return () => {
    media.removeEventListener('change', handler)
    observer.disconnect()
  }
}
