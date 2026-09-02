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
  watchUserPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import ElectronDirectoryPicker from './directory-picker.ts'
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

/** The web-runtime row whose `openBrowser` this app turns off; it has its own window. */
const WEB_RUNTIME_ROW_ID = 'web-runtime'

/** The row that probes the host and mounts a directory-picker backend; this app brings its own. */
const DIRECTORY_PICKER_ROW_ID = 'directory-picker'

/** The client half of the native picker, normally mounted by the row above. */
const DIRECTORY_PICKER_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-native'

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

/**
 * Keep both user patch layers live, so an edit to a `cordis.patch.yml` takes
 * effect without restarting the app. Composition is what mounts an MCP server
 * or any other plugin row, so a desktop user editing that file — or a settings
 * surface writing it — must not need a relaunch to see the result.
 *
 * The web bundle disables the shared module-reload `hmr` row, so a watch-only
 * HMR instance with no module roots is mounted here; it needs the timer service,
 * which a composition may also leave out.
 *
 * Watching is best-effort. A packaged Electron main process runs without
 * `--expose-internals`, which the HMR service requires and a double-clicked app
 * cannot be given, so the mount fails there. Booting is not optional and
 * watching is, so a failure degrades to "an edit needs a relaunch" instead of
 * refusing to start the host.
 * @param ctx - the booted root context.
 * @param profile - the loaded profile, for its own patch path.
 * @param bundlePatches - the bundle layers, recomposed below the user layers.
 * @param overlays - the app's own overlays, recomposed above the user layers.
 */
async function watchPatchLayers(
  ctx: Context,
  profile: Profile,
  bundlePatches: readonly PatchOptions[],
  overlays: readonly PatchOptions[],
): Promise<void> {
  // Fresh clones per generation: the include pushes `insert` rows into the
  // mounted tree by reference, so reusing one parsed object across reloads
  // would bake a user override into the bundle's in-memory row.
  const composeLive = (): PatchOptions[] => structuredClone([
    ...bundlePatches,
    ...loadOptionalPatches(NAME, profile.patchPath) ?? [],
    ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
    ...overlays,
  ])
  try {
    if (ctx.get('hmr') === undefined) {
      if (ctx.get('timer') === undefined) await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
      await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
    }
    await watchUserPatches(ctx, { binName: NAME, filename: profile.patchPath, compose: composeLive })
    await watchUserPatches(ctx, { binName: NAME, filename: homePatchPath(), compose: composeLive })
  } catch (error: unknown) {
    // Not narrowed to the HMR case on purpose: whatever stopped the watch, the
    // app is still usable without it, and the reason belongs in the log rather
    // than in a startup dialog the person cannot act on.
    ctx.logger.warn('dsh-desktop: patch layers are not being watched; an edit to a cordis.patch.yml needs a relaunch: %o', error)
  }
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
 * The browser-session half this app reads back after the tree settles. The Host
 * authenticates every index request, so the window must load the root URL
 * carrying this process's launch token — a bare loopback URL is answered 401.
 */
interface BrowserSession {
  authenticatedUrl: (baseUrl: string) => string
}

/**
 * Read the bound loopback URL from the settled tree, carrying this process's
 * launch token. The token is exchanged for the browser-session cookie by the
 * one `GET /?token=...` the window makes, and never reaches an API path.
 * @param ctx - the booted root context.
 * @returns the URL the window loads.
 * @throws when the composition mounted no web server or no Connection, which
 * means the profile was patched into a shape this app cannot present.
 */
function resolveUrl(ctx: Context): string {
  const server = ctx.get('webServer') as BoundWebServer | undefined
  if (server === undefined) {
    throw new Error(
      `${NAME}-desktop: the ${PROFILE} profile mounted no web server; `
      + `a patch layer in ${homePatchPath()} or the profile's own cordis.patch.yml disabled the webserver row`,
    )
  }
  const connection = ctx.get('connection') as BrowserSession | undefined
  if (connection === undefined) {
    throw new Error(
      `${NAME}-desktop: the ${PROFILE} profile mounted no Connection; `
      + `a patch layer in ${homePatchPath()} or the profile's own cordis.patch.yml disabled the client-connection row`,
    )
  }
  return connection.authenticatedUrl(`http://${server.host}:${server.port}`)
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
  const profile = loadProfile(NAME, PROFILE, INSTALL_ANCHOR)
  // Heals after the profile loads and is handed it: plugins carried only by the
  // profile's selected bundles are linked into its own `node_modules`, which the
  // shared installation mirror does not cover.
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile })
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
  // The profile hands the ready page to a browser, which is right for `dsh web`
  // and wrong here: this app is the window. Overridden as a row config rather
  // than a command flag, because the profile boots no command line to parse one.
  if (rows.has(WEB_RUNTIME_ROW_ID)) {
    overlays.push({
      id: WEB_RUNTIME_ROW_ID,
      config: {
        ...(rows.get(WEB_RUNTIME_ROW_ID)?.config ?? {}) as Record<string, unknown>,
        openBrowser: false,
      },
    })
  }
  // The auto row probes the host and mounts a backend for it; on Windows that
  // backend drives the chooser from a spawned child, which cannot work under an
  // Electron host. This app has a chooser of its own, mounted below.
  if (rows.has(DIRECTORY_PICKER_ROW_ID)) overlays.push({ id: DIRECTORY_PICKER_ROW_ID, disabled: true })
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
  // After the tree settles rather than inside composition: cordis activates an
  // injecting consumer when the service appears, so arriving late costs
  // nothing, while the Loader is only addressable once boot returns. The client
  // half is the same package the disabled row would have mounted — only the
  // backend is this app's own.
  await ctx.plugin(ElectronDirectoryPicker)
  await ctx.loader.create({ name: DIRECTORY_PICKER_SURFACE })
  await watchPatchLayers(ctx, profile, bundlePatches, overlays)
  return { ctx, url: resolveUrl(ctx) }
}
