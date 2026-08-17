/**
 * Stand-in for a harness browser entry while this package is pinned to the
 * registry.
 *
 * A published harness package ships `lib/` and `.d.ts` but no sources, and its
 * browser half is a loader bundle that expects `window.__ModuleLoader__` —
 * nothing a test runner can import. Rather than fail the whole vitest config
 * (which would take the node-only specs down with it), the alias points here,
 * and only a spec that actually reaches for the harness sees this throw.
 * @module @omdsh-plugins/omdsh-codemode/tests/registry-mode-guard
 */

throw new Error(
  'omdsh-codemode: the browser specs need a harness checkout, but this package is pinned to the '
  + "published release. Run 'pnpm run harness:local ../../deepseek-harness && pnpm install', and "
  + "'pnpm run harness:npm && pnpm install' before committing.",
)
