/**
 * Window geometry persistence: remember where the window was and reopen it
 * there.
 *
 * State is written to the app's `userData` directory rather than the Harness
 * home, because it describes this machine's display arrangement and nothing
 * about a session. A restored position is validated against the live displays
 * before use — a window remembered on a monitor that is now unplugged would
 * otherwise open off-screen, where a person cannot reach it.
 * @module @deepseek-ai/dsh-desktop/window-state
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'

/** Remembered geometry; `undefined` position means "let the platform place it". */
export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  /** Restored as a maximized window, with the bounds above kept for unmaximizing. */
  maximized: boolean
}

/** How long to coalesce resize and move events before writing, so a drag writes once. */
const WRITE_DEBOUNCE_MS = 400

/** State file inside the Electron `userData` directory. */
function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/**
 * Whether a remembered rectangle still lands on a connected display. Requires
 * a real overlap, so a window is never restored just off the edge of a screen.
 * @param bounds - the remembered rectangle.
 * @returns whether the rectangle is reachable on the current displays.
 */
function isOnSomeDisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea }) =>
    bounds.x < workArea.x + workArea.width
    && bounds.x + bounds.width > workArea.x
    && bounds.y < workArea.y + workArea.height
    && bounds.y + bounds.height > workArea.y)
}

/**
 * Read remembered geometry, falling back to `defaults` when nothing is stored,
 * the file is unreadable, or the position no longer lands on a display.
 * @param defaults - the size to use when no usable state exists.
 * @returns the geometry to open with.
 */
export function loadWindowState(defaults: { width: number; height: number }): WindowState {
  let stored: Partial<WindowState>
  try {
    stored = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>
  } catch {
    // Absent on first run, and unreadable if a crash truncated the write; both
    // mean "no remembered geometry", which the defaults already describe.
    return { ...defaults, maximized: false }
  }
  const width = typeof stored.width === 'number' ? stored.width : defaults.width
  const height = typeof stored.height === 'number' ? stored.height : defaults.height
  const maximized = stored.maximized === true
  if (typeof stored.x !== 'number' || typeof stored.y !== 'number') return { width, height, maximized }
  const bounds = { x: stored.x, y: stored.y, width, height }
  return isOnSomeDisplay(bounds) ? { ...bounds, maximized } : { width, height, maximized }
}

/**
 * Persist `window`'s geometry as it changes, and once more as it closes.
 * Normal (unmaximized) bounds are recorded so unmaximizing after a restart
 * returns the window to its last floating size.
 * @param window - the window to track.
 */
export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    if (window.isDestroyed()) return
    const { width, height, x, y } = window.getNormalBounds()
    const state: WindowState = { width, height, x, y, maximized: window.isMaximized() }
    try {
      writeFileSync(statePath(), JSON.stringify(state, undefined, 2))
    } catch {
      // Geometry is a convenience; a read-only or full userData directory must
      // not take the window down with it.
    }
  }
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(save, WRITE_DEBOUNCE_MS)
    timer.unref()
  }
  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  window.once('close', () => {
    if (timer !== undefined) clearTimeout(timer)
    save()
  })
}
