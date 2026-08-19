/**
 * Link every workspace package into the repository-root `node_modules` so a
 * source-tree Electron run can resolve bare plugin specifiers.
 *
 * Electron cannot use the Loader's native helper: `node-addon-require-builtin`
 * reaches Node's internal ESM loader through V8 embedder data, which Chromium
 * owns in an Electron process, so `ctx.loader.internal` is always `undefined`
 * there and `boot`'s `bareModuleBaseUrl` has nothing to resolve against. The
 * Loader then imports bare names relative to its own module under `vendor/`,
 * whose pnpm-strict `node_modules` holds none of them.
 *
 * A packaged desktop build does not need this: `pnpm deploy` stages a
 * symlink-free closure in which the Loader and every plugin are siblings under
 * one `node_modules`, which plain ESM resolution walks up into. This script
 * reproduces that reachability for a repository checkout, and must be re-run
 * after any `pnpm install` that rewrites the root `node_modules`.
 * @module scripts/link-electron-runtime
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** Workspace globs that hold linkable packages, as literal directory levels. */
const PACKAGE_ROOTS: readonly { base: string; depth: number }[] = [
  { base: 'packages', depth: 2 },
  { base: 'vendor', depth: 1 },
  { base: 'apps', depth: 1 },
]

/** One workspace package: its declared name and absolute directory. */
interface WorkspacePackage {
  name: string
  dir: string
}

/**
 * Read a package name from a directory holding a manifest.
 * @param dir - absolute package directory.
 * @returns the package, or `undefined` when the directory holds no named manifest.
 */
function readPackage(dir: string): WorkspacePackage | undefined {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
  return typeof manifest.name === 'string' ? { name: manifest.name, dir } : undefined
}

/**
 * Collect every workspace package at a fixed directory depth below `base`.
 * @param base - workspace root directory name.
 * @param depth - directory levels between `base` and each package.
 * @returns the packages found.
 */
function collect(base: string, depth: number): WorkspacePackage[] {
  const baseDir = join(root, base)
  if (!existsSync(baseDir)) return []
  const dirs = depth === 1
    ? readdirSync(baseDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(baseDir, e.name))
    : readdirSync(baseDir, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(group =>
      readdirSync(join(baseDir, group.name), { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => join(baseDir, group.name, e.name)))
  return dirs.map(readPackage).filter((entry): entry is WorkspacePackage => entry !== undefined)
}

/**
 * Add one missing `node_modules` symlink. Anything already present is left
 * untouched — pnpm's own entries carry peer-resolved identities, and replacing
 * them would change what the ordinary CLI resolves.
 * @param target - absolute package directory to link to.
 * @param linkPath - absolute link location under `node_modules`.
 * @returns whether a link was written.
 */
function link(target: string, linkPath: string): boolean {
  if (existsSync(linkPath)) return false
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, 'dir')
  return true
}

const packages = PACKAGE_ROOTS.flatMap(({ base, depth }) => collect(base, depth))
const modulesDir = join(root, 'node_modules')
let written = 0
for (const workspacePackage of packages) {
  if (link(workspacePackage.dir, join(modulesDir, workspacePackage.name))) written += 1
}
console.log(`link-electron-runtime: linked ${written} of ${packages.length} workspace packages into ${modulesDir}`)
