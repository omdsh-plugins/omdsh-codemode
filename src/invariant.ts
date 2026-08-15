/**
 * Package-owned invariant companion for `@omdsh-plugins/omdsh-code`.
 * @module @omdsh-plugins/omdsh-code/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@omdsh-plugins/omdsh-code'

/** Cordis companion plugin name. */
export const name = 'omdsh-code-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant. The host half owns one table — live terminals keyed
 * by workspace directory — whose only consistency rule (a dead process is
 * replaced, never reattached) is asserted directly by this package's own
 * specs; the browser half holds one registered segment and one slot
 * registration, both effect-owned, so there is no cross-plugin state an
 * invariant could watch that disposal does not already settle.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
