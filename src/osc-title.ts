/**
 * The window title a terminal program sets, read out of its own output.
 *
 * `OSC 0`/`OSC 2` is how every terminal program has always said what it is
 * working on, and the harness terminal writes it whenever the conversation is
 * renamed — by `/rename`, or by the name the agent generates after the first
 * turn. This plugin bridges those bytes, so it can read the announcement in
 * passing, with no protocol of its own and nothing added to the terminal.
 *
 * What the announcement is NOT is the new name: the string is the terminal's
 * own label (`<session title> — <program>`), which is that program's
 * formatting and not a field. It says *something changed*; the session log
 * stays the authority on what.
 *
 * Node-free, like [shared](./shared.ts).
 * @module @omdsh-plugins/omdsh-codemode/src/osc-title
 */

/** Introduces an escape sequence. */
const ESC = String.fromCharCode(0x1b)

/** BEL, the older of the two terminators an OSC string may end with. */
const BEL = String.fromCharCode(0x07)

/**
 * `ESC ] 0 ; <text> BEL`, and its three other spellings: icon-and-title (0) or
 * title (2), terminated by BEL or by ST (`ESC \`). The text stops at either
 * terminator, so an unterminated sequence — output cut mid-write — matches
 * nothing and is read again once the rest arrives.
 *
 * Built from `String.fromCharCode` rather than written inline, because a
 * source file carrying raw control bytes is a file every later editor and
 * diff has to survive.
 */
const OSC_TITLE = new RegExp(`${ESC}\\](?:0|2);([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`, 'gu')

/**
 * The TUI's named-session window title is `<session title> — <program>`.
 * The greeting is the product name alone, with no mark.
 */
const SESSION_TITLE_MARK = ' — '

/**
 * Whether a window title already names the conversation, not just the program.
 *
 * Used to tell a greeting (`DeepSeek Harness`) from a generated or `/rename`d
 * title (`Unclear question — DeepSeek Harness`). A pty read can deliver both
 * in one chunk; only the last announcement is visible, and treating that as
 * "the first title, therefore a greeting" would drop the rename.
 * @param windowTitle - the announced title, verbatim.
 * @returns true when the string carries a session name.
 */
export function namesConversation(windowTitle: string): boolean {
  return windowTitle.includes(SESSION_TITLE_MARK)
}

/**
 * The last window title announced in a run of terminal output.
 *
 * The LAST, because a scan of accumulated output can span several
 * announcements and only the newest is true. A caller comparing the result
 * with what it saw before is what turns this into an event.
 * @param output - terminal output, complete sequences or not.
 * @returns the announced title, or undefined when this run announces none.
 */
export function readOscTitle(output: string): string | undefined {
  let found: string | undefined
  for (const match of output.matchAll(OSC_TITLE)) found = match[1]
  return found
}
