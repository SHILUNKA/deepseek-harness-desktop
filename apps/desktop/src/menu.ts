/**
 * Application menu.
 *
 * Electron's built-in default menu is a developer menu — it puts Reload and
 * Toggle Developer Tools in front of everyone. This template keeps the editing
 * and window roles a desktop user expects (without them, even Cmd+C stops
 * working, because the shortcuts live on the menu, not the web page) and moves
 * the developer entries behind a submenu.
 * @module @deepseek-ai/dsh-desktop/menu
 */

import { Menu, shell, type MenuItemConstructorOptions } from 'electron'

/** Where the docs link in the Help menu points. */
const DOCS_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** The macOS application menu, which owns About and Quit on that platform only. */
function appMenu(name: string): MenuItemConstructorOptions[] {
  if (process.platform !== 'darwin') return []
  return [{
    label: name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }]
}

/**
 * Install the application menu.
 * @param name - the product name shown in the macOS application menu.
 */
export function installApplicationMenu(name: string): void {
  const template: MenuItemConstructorOptions[] = [
    ...appMenu(name),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Developer',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
          ],
        },
      ],
    },
    {
      label: 'Window',
      submenu: process.platform === 'darwin'
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [{
        label: 'Documentation',
        click: () => { void shell.openExternal(DOCS_URL) },
      }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
