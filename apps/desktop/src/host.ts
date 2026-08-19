/**
 * Desktop host assembly: boots the shipped `web` profile inside the Electron
 * main process and reports the loopback URL its web server bound.
 *
 * The desktop application owns no plugin roster: it boots the same `web`
 * profile `dsh web` boots, from the same `@deepseek-ai/dsh` installation, so a
 * person's `cordis.patch.yml` layers and installed plugins apply identically on
 * both surfaces. The one invocation difference is `--port 0`: the OS picks a
 * free loopback port and the window is handed the resulting URL, so a desktop
 * user never learns a port number and a second instance cannot collide with a
 * running `dsh web`.
 *
 * Assembly lives in the app, never in a package: this module is the desktop
 * counterpart of the CLI's profile boot, and the two surfaces share only the
 * `@deepseek-ai/dsh-app-boot` glue.
 * @module @deepseek-ai/dsh-desktop/host
 */

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

/** The diagnostic prefix and Harness home namespace this app boots under — the same installation `dsh` uses. */
const NAME = 'dsh'

/** The profile this app boots; sharing `web` is what keeps CLI and desktop compositions identical. */
const PROFILE = 'web'

/** Root config filename inside a profile directory. */
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** The session-telemetry row id the `DSH_TELEMETRY_DISABLED` switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list the profile's patch layers compose over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml.
# Edit cordis.patch.yml, not this file.
[]
`

const require = createRequire(import.meta.url)

/**
 * The `@deepseek-ai/dsh` installation this app boots. Its dependency graph is
 * the plugin roster `healProfilesModuleFallback` links into the profile, and
 * its `config/` ships the agent presets, so the desktop app resolves both from
 * the CLI package rather than restating them.
 */
const INSTALL_ANCHOR = require.resolve('@deepseek-ai/dsh/package.json')

/** Shipped agent-preset root, beside the resolved `dsh` installation's own manifest. */
const SHIPPED_PRESET_ROOT = join(dirname(INSTALL_ANCHOR), 'config', 'agent-presets') + '/'

/**
 * Resolve bare plugin specifiers against the profile's own root config, so
 * Node walks up into the healed `profiles/node_modules` fallback that
 * {@link healProfilesModuleFallback} links the whole installation into. Without
 * an explicit base, the Loader imports bare names relative to its own module
 * inside `vendor/`, whose pnpm-strict `node_modules` carries none of them; the
 * CLI never hits this because its source launch resolves through tsx.
 * @param rootConfigPath - absolute path of the profile's `cordis.yml`.
 * @returns the base URL for bare specifier resolution.
 */
function bareModuleBaseUrl(rootConfigPath: string): string {
  return pathToFileURL(rootConfigPath).href
}

/** The home-level user patch layer applied over the profile's own. */
function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value disables, matching the CLI: a privacy switch prefers off-by-mistake
 * over on-by-mistake.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when none is required.
 */
function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** A booted desktop host: the live root context and the URL its web server bound. */
export interface DesktopHost {
  /** The booted root context; dispose its fiber to shut the tree down. */
  ctx: Context
  /** Loopback URL the renderer loads, with the OS-assigned port already resolved. */
  url: string
}

/** The web server facts this app reads back after the tree settles. */
interface BoundWebServer {
  host: string
  port: number
}

/**
 * Read the bound loopback URL from the settled tree.
 * @param ctx - the booted root context.
 * @returns the URL the window loads.
 * @throws when the composition mounted no web server, which means the profile
 * was patched into a shape this app cannot present.
 */
function resolveUrl(ctx: Context): string {
  const server = ctx.get('webServer') as BoundWebServer | undefined
  if (server === undefined) {
    throw new Error(
      `${NAME}-desktop: the ${PROFILE} profile mounted no web server; `
      + `a patch layer in ${homePatchPath()} or the profile's own cordis.patch.yml disabled the webserver row`,
    )
  }
  return `http://${server.host}:${server.port}`
}

/** Options for {@link startDesktopHost}. */
export interface StartDesktopHostOptions {
  /**
   * Invoked when a mounted plugin requests process exit through `ctx.appExit`.
   * The desktop shell owns what that means (quit the app), so the host never
   * calls `process.exit` itself.
   */
  onExitRequest: (code: number) => void
}

/**
 * Boot the `web` profile in this process and bind a free loopback port.
 * @param options - the shell's exit-request handler.
 * @returns the booted host: root context plus the URL to load.
 * @throws a labelled error after disposing the partial tree when profile
 * composition or plugin startup fails.
 */
export async function startDesktopHost(options: StartDesktopHostOptions): Promise<DesktopHost> {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, PROFILE, INSTALL_ANCHOR)
  const rootConfigPath = join(profile.dir, PROFILE_ROOT_FILENAME)
  // Always rewritten: the whole composition is patch layers, and the Loader's
  // tree write-back can otherwise bake composed rows into this file, which
  // would duplicate every bundle insert on the next boot.
  writeFileSync(rootConfigPath, PROFILE_ROOT_CONFIG)

  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }

  const overlays: PatchOptions[] = []
  // The shipped preset root is the part of the roster only an installed app can
  // resolve; the writable root stays the presets plugin's own default.
  if (rows.has('agent-presets')) {
    overlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) overlays.push(telemetryPatch)

  const environment = loadLayeredEnv(NAME)
  const app: { current?: Context } = {}
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const patches = structuredClone([...bundlePatches, ...profile.patches, ...homePatches, ...overlays])
  const ctx = await boot(NAME, rootConfigPath, patches, (hostCtx) => {
    app.current = hostCtx
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    // `--port 0` is the whole desktop invocation: bind a free loopback port and
    // let the window read it back, so no port is ever user-facing.
    provideCmdline(hostCtx, { args: ['--port', '0'], exit: options.onExitRequest })
  }, bareModuleBaseUrl(rootConfigPath))
  app.current = ctx
  return { ctx, url: resolveUrl(ctx) }
}
