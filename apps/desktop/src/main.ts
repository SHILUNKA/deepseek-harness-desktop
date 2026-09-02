/**
 * Electron main process: the desktop shell around one in-process `web` profile
 * host.
 *
 * Lifetime is a straight line — acquire the single-instance lock, show a
 * splash window, boot the host, point the window at the loopback URL it bound,
 * and dispose the tree before the process exits. The renderer is the shipped
 * web frontend, unmodified: it reaches the host over the same loopback HTTP and
 * WebSocket routes a browser would use, so this shell owns window and lifecycle
 * behavior only and never the product surface.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { startDesktopHost, type DesktopHost } from './host.ts'
import { installApplicationMenu } from './menu.ts'
import { checkForUpdates } from './update-flow.ts'
import { loadWindowState, trackWindowState } from './window-state.ts'

/** Product name shown in the window title and the macOS application menu. */
const PRODUCT_NAME = 'DeepSeek Harness'

/** Splash document shown while the host boots; both source and built layouts sit one directory under the app root. */
const SPLASH_PATH = fileURLToPath(new URL('../assets/splash.html', import.meta.url))

/** How long teardown may take before the process exits anyway, so a wedged plugin cannot strand a quit. */
const SHUTDOWN_TIMEOUT_MS = 5000

/** Initial window size; the window is resizable and the platform restores nothing beyond this default. */
const WINDOW_DEFAULTS = { width: 1280, height: 860, minWidth: 720, minHeight: 480 } as const

/**
 * Render an error with every nested cause and aggregated member, because a
 * plugin-tree failure arrives as an `AggregateError` whose own stack names only
 * the loader — the actionable diagnostic is always in the members.
 * @param error - the thrown value.
 * @param depth - current nesting level, used to indent nested members.
 * @returns the printable report.
 */
function describeError(error: unknown, depth = 0): string {
  const indent = '  '.repeat(depth)
  if (!(error instanceof Error)) return `${indent}${String(error)}`
  const lines = [`${indent}${error.stack ?? `${error.name}: ${error.message}`}`]
  if (error instanceof AggregateError) {
    for (const member of error.errors) lines.push(describeError(member, depth + 1))
  }
  if (error.cause !== undefined) lines.push(describeError(error.cause, depth + 1))
  return lines.join('\n')
}

/** The booted host, present once {@link bootHost} resolves. */
let host: DesktopHost | undefined

/** The shell's one window, recreated on macOS dock activation while the app lives. */
let window: BrowserWindow | undefined

/** Guards the asynchronous teardown from re-entering through the second `before-quit`. */
let shuttingDown = false

/**
 * Create the shell window showing the splash document.
 * @returns the created window.
 */
function createWindow(): BrowserWindow {
  const state = loadWindowState(WINDOW_DEFAULTS)
  const created = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...state.x !== undefined && state.y !== undefined && { x: state.x, y: state.y },
    minWidth: WINDOW_DEFAULTS.minWidth,
    minHeight: WINDOW_DEFAULTS.minHeight,
    show: true,
    title: PRODUCT_NAME,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      // The renderer is ordinary web content served over loopback: it needs no
      // Node access, and the host is reached through the same HTTP and
      // WebSocket routes a browser uses.
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // Anything the app opens in a new window (documentation, provider consoles)
  // belongs in the person's own browser, not in a chrome-less Electron window.
  created.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (state.maximized) created.maximize()
  trackWindowState(created)
  void created.loadFile(SPLASH_PATH)
  return created
}

/**
 * Boot the host and point the window at it. A boot failure is shown rather
 * than swallowed: a desktop user has no console to read a stack trace from.
 * @param target - the window to load the booted URL into.
 */
async function bootHost(target: BrowserWindow): Promise<void> {
  try {
    host = await startDesktopHost({ onExitRequest: () => { app.quit() } })
  } catch (error) {
    const detail = describeError(error)
    // Both sinks: the dialog is the only channel a double-clicked app has, and
    // the stderr line is the only channel a terminal launch or a CI run has.
    console.error(`dsh-desktop: host failed to start\n${detail}`)
    dialog.showErrorBox('DeepSeek Harness failed to start', detail)
    app.exit(1)
    return
  }
  if (target.isDestroyed()) return
  await target.loadURL(host.url)
}

/**
 * Dispose the plugin tree, bounded by {@link SHUTDOWN_TIMEOUT_MS}.
 * @returns once the tree settled or the bound elapsed.
 */
async function disposeHost(): Promise<void> {
  const tree = host
  if (tree === undefined) return
  host = undefined
  await Promise.race([
    tree.ctx.fiber.dispose(),
    new Promise<void>((resolve) => { setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref() }),
  ])
}

// A second launch (Finder, taskbar, a shell alias) must reach the running
// window instead of booting a second host over the same session storage.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.on('window-all-closed', () => {
    // The host is a full agent runtime; keeping it alive behind a closed window
    // would leave an invisible process holding the session store, so every
    // platform quits here, including macOS.
    app.quit()
  })

  app.on('activate', () => {
    if (window !== undefined && !window.isDestroyed()) return
    window = createWindow()
    if (host !== undefined) void window.loadURL(host.url)
  })

  app.on('before-quit', (event) => {
    if (shuttingDown || host === undefined) return
    // Electron does not await asynchronous teardown, so the first quit is
    // cancelled, the tree disposed, and the quit reissued.
    event.preventDefault()
    shuttingDown = true
    void disposeHost().finally(() => { app.quit() })
  })

  void app.whenReady().then(async () => {
    // The interface language. The locale plugin reads `navigator.languages` and
    // falls back to English when it names no language it ships, so on a machine
    // whose system language is not Chinese the same build opens in English.
    // This app ships for Chinese users, so it states the language instead of
    // inheriting it — the accept-languages argument is what reaches
    // `navigator.languages`, which a command-line switch does not. Settings
    // still overrides this per person.
    session.defaultSession.setUserAgent(session.defaultSession.getUserAgent(), 'zh-CN')
    installApplicationMenu(PRODUCT_NAME, () => { void checkForUpdates(window, true) })
    window = createWindow()
    await bootHost(window)
    // After the host is up, never before: the check is the least important
    // thing happening at launch, and it must not compete with boot for the
    // network or delay the first paint. Failure is logged, never surfaced —
    // the person did not ask for this one.
    void checkForUpdates(window, false)
  })
}
