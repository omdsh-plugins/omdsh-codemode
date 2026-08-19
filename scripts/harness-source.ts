/**
 * Switch which harness this plugin builds against.
 *
 * Two sources, one switch — the shape `omdsh-desktop` uses for the same
 * problem:
 *
 * - **registry** (default, and the only state that belongs in a commit) — the
 *   `@deepseek-ai/*` devDependencies name {@link HARNESS_VERSION}. A bare
 *   clone can install and build itself, which is what lets `dsh plugin add
 *   github:...` work through `prepare`.
 * - **local** — those devDependencies become `link:` specifiers into a sibling
 *   harness checkout, so unreleased work in that checkout is what this plugin
 *   compiles against. pnpm does not install a linked package's own
 *   dependencies, so that checkout must be installed and built (`pnpm run
 *   build`) first.
 *
 * The checkout path is an ARGUMENT, never a committed value: a `link:` is
 * resolved relative to the manifest that declares it, so committing one bakes
 * one machine's directory layout into the package — and pnpm does not even
 * fail loudly when it is wrong. It creates a dangling symlink, `install`
 * reports success, and the build dies later with TS2307 on every harness
 * import.
 *
 * Run: `pnpm run harness:local ../../deepseek-harness`, `pnpm run
 * harness:npm`, or `pnpm run check:harness-pin`.
 * @module @omdsh-plugins/omdsh-codemode/scripts/harness-source
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/** Diagnostic prefix on this script's logs and errors. */
const PREFIX = 'harness-source'

/** The harness release this plugin is pinned to when it builds from the registry. */
const HARNESS_VERSION = '0.1.0-rc.8'

/**
 * The framework is versioned on its own train, not the harness release's, so
 * the pin above does not apply to it.
 */
const CORDIS_VERSION = '^4.0.1'

/** Every harness package this plugin builds against, and where it lives in a checkout. */
const HARNESS_PACKAGES: Readonly<Record<string, string>> = {
  '@deepseek-ai/cordis': join('vendor', 'cordis'),
  '@deepseek-ai/dsh-client-locale': join('packages', 'client', 'locale'),
  '@deepseek-ai/dsh-client-runtime': join('packages', 'client', 'runtime'),
  '@deepseek-ai/dsh-client-ui-layout': join('packages', 'client', 'ui-layout'),
  '@deepseek-ai/dsh-client-ui-primitives': join('packages', 'client', 'ui-primitives'),
  '@deepseek-ai/dsh-client-ui-slots': join('packages', 'client', 'ui-slots'),
  '@deepseek-ai/dsh-host-webserver': join('packages', 'host', 'webserver'),
  '@deepseek-ai/dsh-invariants': join('packages', 'runtime-diagnostics', 'invariants'),
  '@deepseek-ai/dsh-session': join('packages', 'core', 'session'),
}

/** The manifest this script rewrites. */
interface Manifest {
  devDependencies?: Record<string, string>
}

/**
 * The registry specifier for one harness package.
 * @param name - the package name.
 * @returns its pinned version range.
 */
function registrySpecifier(name: string): string {
  return name === '@deepseek-ai/cordis' ? CORDIS_VERSION : HARNESS_VERSION
}

/**
 * Rewrite every harness devDependency through one mapping.
 * @param specifier - produces the new specifier for one package name.
 */
async function rewrite(specifier: (name: string) => string): Promise<void> {
  const path = join(root, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
  const devDependencies = manifest.devDependencies
  if (devDependencies === undefined) throw new Error(`${PREFIX}: package.json declares no devDependencies.`)
  for (const name of Object.keys(HARNESS_PACKAGES)) devDependencies[name] = specifier(name)
  await writeFile(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/**
 * Point the manifest at a sibling harness checkout.
 * @param checkout - path to the checkout, absolute or relative to this package.
 */
async function useLocal(checkout: string): Promise<void> {
  const absolute = resolve(root, checkout)
  for (const directory of Object.values(HARNESS_PACKAGES)) {
    if (!existsSync(join(absolute, directory, 'package.json'))) {
      throw new Error(`${PREFIX}: ${absolute} is not a harness checkout: ${directory}/package.json is absent.`)
    }
  }
  // Resolved against the manifest that declares it, so the path is computed
  // from this package's own directory — and computed HERE, per machine,
  // rather than written down once and hoped for.
  await rewrite(name => `link:${toPosix(relative(root, join(absolute, HARNESS_PACKAGES[name] ?? '')))}`)
  console.log(`${PREFIX}: building against the checkout at ${absolute}`)
  console.log(`${PREFIX}: run 'pnpm install'; that checkout must be installed and built ('pnpm run build') for its lib/ to resolve.`)
  console.log(`${PREFIX}: run 'pnpm run harness:npm' before committing — a link: specifier is one machine's layout.`)
}

/** Point the manifest back at the pinned published release. */
async function useRegistry(): Promise<void> {
  await rewrite(registrySpecifier)
  console.log(`${PREFIX}: building against the published harness ${HARNESS_VERSION}`)
  console.log(`${PREFIX}: run 'pnpm install'.`)
}

/**
 * Prove the manifest carries the pin, so a commit cannot ship one machine's
 * `link:` paths. A checkout switched to a local harness reports as such and
 * FAILS: unlike the desktop's runtime pin, a link here breaks `prepare` for
 * everyone installing this plugin by git URL.
 */
async function check(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Manifest
  const devDependencies = manifest.devDependencies ?? {}
  const linked = Object.keys(HARNESS_PACKAGES).filter(name => devDependencies[name]?.startsWith('link:') === true)
  if (linked.length > 0) {
    throw new Error(
      `${PREFIX}: ${String(linked.length)} harness devDependencies are linked to a local checkout `
      + `(${linked.join(', ')}); run 'pnpm run harness:npm' before committing.`,
    )
  }
  const drifted = Object.keys(HARNESS_PACKAGES)
    .filter(name => devDependencies[name] !== registrySpecifier(name))
  if (drifted.length > 0) {
    throw new Error(`${PREFIX}: ${drifted.join(', ')} do not match the pin ${HARNESS_VERSION}.`)
  }
  console.log(`${PREFIX}: every harness devDependency matches the pin ${HARNESS_VERSION}.`)
}

/**
 * Normalize a platform-native relative path for a manifest specifier.
 * @param path - a platform-native relative path.
 * @returns the same path with POSIX separators.
 */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: {
    local: { type: 'boolean', default: false },
    npm: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

if (values.check) await check()
else if (values.npm) await useRegistry()
else if (values.local) {
  const checkout = positionals[0]
  if (checkout === undefined) throw new Error(`${PREFIX}: --local needs the path to a harness checkout.`)
  await useLocal(checkout)
}
else throw new Error(`${PREFIX}: pass --local <checkout>, --npm, or --check.`)
