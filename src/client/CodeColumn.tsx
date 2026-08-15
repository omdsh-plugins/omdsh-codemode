/**
 * The slot component: the conversation seat's occupant while Code mode holds
 * the column.
 *
 * Thin on purpose. It reads the live scope out of the injected hook and hands
 * it to {@link CodeSurface}, which is a plain-props component so its socket
 * and grid can be exercised without the framework's standard kit around them.
 */

import type { CodeColumnProps } from './contract.ts'
import { CodeSurface } from './CodeSurface.tsx'

/**
 * Render the terminal column for the current conversation.
 * @param props - composed slot props (contract.ts).
 * @returns the terminal surface.
 */
export function CodeColumn({ useScope, noteAttached, noteTitle, t }: CodeColumnProps) {
  const scope = useScope(state => state)
  return (
    <CodeSurface
      scope={scope}
      // The directory comes from the scope this socket was opened for, not
      // from whatever the scope is when the answer arrives: the two differ
      // exactly when the user moved on, and the pairing must stay honest.
      onAttached={(cwd, codeSessionId) => { noteAttached(cwd, codeSessionId) }}
      onTitle={(cwd, title) => { noteTitle(cwd, title) }}
      t={t}
    />
  )
}
