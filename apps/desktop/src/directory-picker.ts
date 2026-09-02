/**
 * Directory picking through Electron's own dialog.
 *
 * The shipped native backend drives the Win32 `IFileOpenDialog` from a child
 * process it spawns as `process.execPath` with koffi bound inside it. Every one
 * of those steps assumes a plain-node host: under Electron `process.execPath`
 * is the application executable, the child is a second copy of the app that
 * this app's single-instance lock quits on sight, and the FFI binding has to
 * survive the packaged tree's module layout. The reported failure — "win32
 * folder dialog worker exited before reporting a result" — is that chain
 * breaking, and none of it is observable from a machine that cannot run the
 * packaged Windows app.
 *
 * An Electron host does not need any of it: `dialog.showOpenDialog` is the same
 * system chooser, opened in-process by the framework already running the
 * window. No child process, no FFI, no path resolution inside the asar-free
 * tree — and it is the identical call on all three platforms, so the desktop
 * app stops depending on a backend chosen by probing the host's environment.
 * @module @deepseek-ai/dsh-desktop/directory-picker
 */

import { BrowserWindow, dialog } from 'electron'
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'

/** `ctx.directoryPicker` for the desktop app: the framework's own chooser. */
export default class ElectronDirectoryPicker extends DirectoryPicker {
  /** Stable for the service lifetime, as consumers may capture it across calls. */
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    pick: signal => this.pick(signal),
  }

  /**
   * Open the system folder chooser.
   *
   * Owned by the window when there is one, which is what makes it a sheet on
   * macOS and keeps it in front of the app elsewhere; a chooser that can end up
   * behind the window reads exactly like the failure this replaces.
   * @param signal - caller lifetime; an abort abandons the operator's answer.
   * @returns the chosen absolute path, or null when cancelled.
   */
  private async pick(signal: AbortSignal): Promise<string | null> {
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      // `createDirectory` is the macOS new-folder button; `dontAddToRecent`
      // keeps a workspace choice out of the OS's recent-documents list.
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] as const,
    }
    const result = owner === undefined
      ? await dialog.showOpenDialog({ properties: [...options.properties] })
      : await dialog.showOpenDialog(owner, { properties: [...options.properties] })
    // The dialog cannot be closed programmatically, so an abort that arrives
    // while it is open is honoured by discarding the answer rather than by
    // handing back a directory nobody is waiting for any more.
    if (signal.aborted || result.canceled) return null
    return result.filePaths[0] ?? null
  }

  /**
   * The interaction this host offers.
   * @returns the native capability, stable for the service lifetime.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
