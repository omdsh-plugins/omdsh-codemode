/**
 * The mode switch's segment registry, as this plugin reads it.
 *
 * The types are `@omdsh-plugins/omdsh-basemode`'s own, imported type-only. A
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
} from '@omdsh-plugins/omdsh-basemode/client'

/** Service name the registry is published under. */
export const SESSION_MODES = 'sessionModes'

/**
 * The one segment field this plugin reads that `@omdsh-plugins/omdsh-basemode`
 * gained after the release this package compiles against.
 *
 * Declared here rather than waited for, because a type-level dependency on an
 * unreleased version would make the two packages releasable only in one order,
 * and nothing about this reading needs that. Absent means IN a project, which
 * is both the field's own default and the behaviour this plugin had before the
 * question existed — so an older registry degrades to exactly what it did.
 *
 * `id` is carried only so the cast at the reading site has something in common
 * with `ModeSegment` and stays a narrowing rather than an `unknown` laundering.
 */
export interface ModeProjectClaim {
  /** The segment's id, as {@link ModeSegment} carries it. */
  readonly id: string
  /** Whether this mode's conversations live in a project a terminal could run in. */
  readonly inProject?: boolean
}
