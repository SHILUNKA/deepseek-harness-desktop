/**
 * Stage and package the desktop application.
 *
 * Packaging runs against a deployed closure, never the workspace: `pnpm deploy`
 * with the hoisted linker writes a flat `node_modules` in which the Loader and
 * every plugin are siblings, which is the only layout plain ESM resolution can
 * walk — Electron cannot use the Loader's native helper for bare specifiers
 * (see scripts/link-electron-runtime.ts).
 *
 * The deploy alone is not complete. Two classes of package are missing from it
 * and are restored here from the workspace:
 *
 * - **Service Definition packages** (`dsh-fs`, `dsh-shell`, `dsh-subprocess`, …)
 *   are `peerDependencies` of their implementations by repository convention,
 *   and the deploy runs with `auto-install-peers=false`.
 * - **Vendored packages overridden to `link:`** (`cosmokit`, `schemastery`)
 *   resolve through a workspace-relative link the deploy cannot carry.
 *
 * Each restored package is copied without its own `node_modules`, keeping one
 * flat Cordis instance in the payload.
 * @module scripts/build-desktop
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/**
 * Deploy target: the packaged application's file tree.
 *
 * Kept outside the repository. `pnpm deploy` records its own linker choice in
 * the tree it writes, and a staging directory inside the workspace leaves every
 * later pnpm command in the repository convinced its dependencies are out of
 * sync — including the pre-push hooks.
 */
const STAGING = join(tmpdir(), 'dsh-desktop-staging')

/** Installer output directory. */
const OUTPUT = join(root, 'dist-desktop', 'out')

/** The workspace member that is packaged. */
const APP_PACKAGE = '@deepseek-ai/dsh-desktop'

/** Workspace roots holding packages that may need restoring, as literal directory levels. */
const PACKAGE_ROOTS: readonly { base: string; depth: number }[] = [
  { base: 'packages', depth: 2 },
  { base: 'vendor', depth: 1 },
]

/**
 * Run a command, inheriting stdio, and reject on a non-zero exit.
 * @param command - executable name.
 * @param args - arguments.
 * @param cwd - working directory.
 * @returns once the command exits successfully.
 */
async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((settle, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) settle()
      else reject(new Error(`build-desktop: ${command} exited ${String(code)}`))
    })
  })
}

/** One workspace package: its declared name and absolute directory. */
interface WorkspacePackage {
  name: string
  dir: string
}

/**
 * Read a package manifest's name.
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
 * Collect every workspace package at a fixed depth below `base`.
 * @param base - workspace root directory name.
 * @param depth - directory levels between `base` and each package.
 * @returns the packages found.
 */
async function collect(base: string, depth: number): Promise<WorkspacePackage[]> {
  const baseDir = join(root, base)
  if (!existsSync(baseDir)) return []
  const groups = (await readdir(baseDir, { withFileTypes: true })).filter(e => e.isDirectory())
  const dirs = depth === 1
    ? groups.map(e => join(baseDir, e.name))
    : (await Promise.all(groups.map(async group =>
      (await readdir(join(baseDir, group.name), { withFileTypes: true }))
        .filter(e => e.isDirectory())
        .map(e => join(baseDir, group.name, e.name))))).flat()
  return dirs.map(readPackage).filter((entry): entry is WorkspacePackage => entry !== undefined)
}

/**
 * Copy every workspace package the deploy omitted into the staged closure.
 * @returns the number of packages restored.
 */
async function restoreMissingPackages(): Promise<number> {
  const packages = (await Promise.all(PACKAGE_ROOTS.map(async ({ base, depth }) => collect(base, depth)))).flat()
  let restored = 0
  for (const workspacePackage of packages) {
    const destination = join(STAGING, 'node_modules', workspacePackage.name)
    if (existsSync(destination)) continue
    await mkdir(dirname(destination), { recursive: true })
    await cp(workspacePackage.dir, destination, {
      recursive: true,
      // A package-local node_modules would introduce a second Cordis instance
      // into a payload whose whole premise is one flat resolution root.
      filter: source => !source.includes(join('', 'node_modules')),
    })
    restored += 1
  }
  return restored
}

/**
 * The Electron version the installers embed, read from the app's own
 * devDependency rather than assumed, so a bump cannot silently package a
 * different runtime than the one developed against.
 * @returns the resolved version string.
 */
function electronVersion(): string {
  const fromApp = createRequire(join(root, 'apps', 'desktop', 'package.json'))
  const manifest = JSON.parse(
    readFileSync(fromApp.resolve('electron/package.json'), 'utf8'),
  ) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('build-desktop: electron package.json declares no version')
  return manifest.version
}

/**
 * Strip dependency fields from the staged manifest.
 *
 * The closure is already complete and was assembled by this script, partly from
 * the workspace. electron-builder reads a manifest that still declares
 * dependencies as work to do and runs `pnpm install --production` over the
 * staging tree, which fails the same way a nested `pnpm deploy` does. Node
 * resolves imports from `node_modules`, never from these fields, so removing
 * them changes nothing at runtime.
 */
async function neutralizeStagedManifest(): Promise<void> {
  const manifestPath = join(STAGING, 'package.json')
  const {
    dependencies: _dependencies,
    devDependencies: _devDependencies,
    peerDependencies: _peerDependencies,
    optionalDependencies: _optionalDependencies,
    scripts: _scripts,
    ...kept
  } = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  // electron-builder writes this into the bundle metadata, and the Linux deb
  // target rejects a build whose author carries no email address; the workspace
  // manifest has no reason to carry either.
  kept.author ??= 'DeepSeek AI <noreply@deepseek.com>'
  // Debian names its artifact after the package name, so a scoped name turns
  // the `@scope/` segment into a directory that nothing created and the build
  // dies writing the .deb. macOS and Windows name theirs after productName and
  // are unaffected either way.
  kept.name = 'dsh-desktop'
  await writeFile(manifestPath, `${JSON.stringify(kept, undefined, 2)}\n`)
}

/**
 * Write the electron-builder configuration into the staged closure.
 *
 * `asar: false` is required, not a preference: `healProfilesModuleFallback`
 * symlinks the installed packages into `~/.dsh/profiles/node_modules`, and the
 * operating system resolves those links. A target inside an asar archive is not
 * a real filesystem path, so every one of them would dangle.
 */
async function writeBuilderConfig(): Promise<void> {
  const config = `# Generated by scripts/build-desktop.ts — edit that script, not this file.
appId: ai.deepseek.harness.desktop
productName: DeepSeek Harness
electronVersion: ${electronVersion()}
asar: false
npmRebuild: false
directories:
  output: ${JSON.stringify(OUTPUT)}
files:
  - "**/*"
  - "!node_modules/**/*"
  - "!**/*.map"
  - "!**/tsconfig*.json"
  - "!**/*.tsbuildinfo"
# The closure is carried as a resource, not as declared dependencies.
# electron-builder derives what to copy from the manifest's dependency fields
# and would otherwise try to install them itself; with those fields removed it
# copies no modules at all. Landing them at \`app/node_modules\` puts the flat
# tree exactly where Node resolves it from \`app/lib/main.js\`.
extraResources:
  - from: node_modules
    to: app/node_modules
mac:
  # Architecture comes from the command line, so each build pairs its target
  # with a closure deployed for that same architecture.
  target: [dmg, zip]
  category: public.app-category.developer-tools
win:
  target: [nsis]
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
linux:
  target: [AppImage, deb]
  category: Development
`
  await writeFile(join(STAGING, 'electron-builder.yml'), config)
}

// `pnpm deploy` refuses to run beneath another pnpm process: it recognizes the
// parent invocation regardless of the child's environment, redirects its
// internal install at the workspace, and stops for an interactive confirmation
// to purge a modules directory. Clearing or replacing the environment does not
// avoid it, so this script must be started directly rather than through
// `pnpm run` / `pnpm exec`.
if ((process.env.npm_config_user_agent ?? '').length > 0) {
  console.error(
    'build-desktop: cannot run under pnpm — `pnpm deploy` would target the workspace instead of the staging tree.\n'
    + '  Run it directly instead:\n'
    + '    node --import tsx/esm scripts/build-desktop.ts [--stage-only] [--platform mac|win|linux]',
  )
  process.exit(1)
}

const { values } = parseArgs({
  options: {
    'stage-only': { type: 'boolean', default: false },
    platform: { type: 'string' },
    arch: { type: 'string' },
  },
})


await rm(STAGING, { recursive: true, force: true })
await rm(OUTPUT, { recursive: true, force: true })
// Only the parent: `pnpm deploy` must create the target itself. Handing it an
// existing directory makes it treat the target as a modules directory to purge,
// which needs an interactive confirmation it cannot get from a script.
await mkdir(dirname(STAGING), { recursive: true })
await run('pnpm', [
  '--filter', APP_PACKAGE, 'deploy',
  '--legacy',
  '--prod',
  '--config.node-linker=hoisted',
  '--config.auto-install-peers=false',
  '--config.link-workspace-packages=true',
  STAGING,
], root)

const restored = await restoreMissingPackages()
console.log(`build-desktop: restored ${restored} workspace packages the deploy omitted`)
await neutralizeStagedManifest()
await writeBuilderConfig()

if (values['stage-only']) {
  console.log(`build-desktop: staged at ${STAGING}`)
} else {
  const platform = values.platform === undefined ? [] : [`--${values.platform}`]
  const arch = values.arch === undefined ? [] : [`--${values.arch}`]
  // The binary is invoked directly rather than through `pnpm exec`, which
  // verifies workspace dependencies before running anything and reaches the
  // same failing install. electron-builder itself lives in the workspace and is
  // pointed at the staged closure, which `--prod` deliberately excluded it from.
  const builderBin = join(root, 'apps', 'desktop', 'node_modules', '.bin', 'electron-builder')
  await run(builderBin, [
    '--projectDir', STAGING,
    '--config', join(STAGING, 'electron-builder.yml'),
    // This script only ever produces local artifacts. Without it, electron-builder
    // treats a CI run as a release and fails demanding a GitHub token.
    '--publish', 'never',
    ...platform,
    ...arch,
  ], root)
  console.log(`build-desktop: installers in ${OUTPUT}`)
}
