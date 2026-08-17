/**
 * The mode switch's segment registry, as this plugin reads it.
 *
 * The types are `@omdsh-plugins/omdsh-base`'s own, imported type-only. A
 * mirrored copy would have been cheaper to install and worse to live with: the
 * registry gained a method the day this file was written, and a hand-kept
 * mirror is a contract that agrees with the real one only until someone
 * forgets. Type-only imports are erased before the client bundle exists, so
 * nothing of that package reaches this artifact and the purity gate never sees
 * it — the two halves of the arrangement that make this safe.
 *
 * What is NOT imported is the service name. `SESSION_MODES` is a literal here
 * and a literal there, because cordis binds services by name at runtime: the
 * string is a wire word the two packages share, not a symbol one owns.
 * @module @omdsh-plugins/omdsh-codemode/src/client/session-modes
 */

export type {
  ColumnScope, ModeSegment, ModeSegmentInput, ModeSegmentPatch, SessionModes,
} from '@omdsh-plugins/omdsh-base/client'

/** Service name the registry is published under. */
export const SESSION_MODES = 'sessionModes'
