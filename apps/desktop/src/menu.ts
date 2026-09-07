/**
 * Application menu.
 *
 * Electron's built-in default menu is a developer menu — it puts Reload and
 * Toggle Developer Tools in front of everyone. This template keeps the editing
 * and window roles a desktop user expects (without them, even Cmd+C stops
 * working, because the shortcuts live on the menu, not the web page) and moves
 * the developer entries behind a submenu.
 *
 * Every label is written out in Chinese, including the ones a `role` would
 * otherwise fill in. Electron localizes a role's label from the *system*
 * language, so on a machine whose Windows is not Chinese the same build shows
 * "Edit / View / Window / Help" beside a fully Chinese interface. This app
 * ships for Chinese users and states its language rather than inheriting it,
 * the same choice `main.ts` makes for `navigator.languages`.
 * @module @deepseek-ai/dsh-desktop/menu
 */

import { Menu, shell, type MenuItemConstructorOptions } from 'electron'

/** Where the docs link in the Help menu points. */
const DOCS_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** The macOS application menu, which owns About and Quit on that platform only. */
function appMenu(name: string, onCheckForUpdates: () => void): MenuItemConstructorOptions[] {
  if (process.platform !== 'darwin') return []
  return [{
    label: name,
    submenu: [
      { role: 'about' },
      // Directly under About is where macOS puts this, and where a person
      // looks for it; every other platform keeps it in Help.
      { label: '检查更新…', click: onCheckForUpdates },
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
 * @param onCheckForUpdates - runs the interactive update check.
 */
export function installApplicationMenu(name: string, onCheckForUpdates: () => void): void {
  const template: MenuItemConstructorOptions[] = [
    ...appMenu(name, onCheckForUpdates),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
        { type: 'separator' },
        {
          label: '开发者',
          submenu: [
            { role: 'reload', label: '重新加载' },
            { role: 'forceReload', label: '强制重新加载' },
            { role: 'toggleDevTools', label: '开发者工具' },
          ],
        },
      ],
    },
    {
      label: '窗口',
      submenu: process.platform === 'darwin'
        ? [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { type: 'separator' }, { role: 'front', label: '全部置于顶层' }]
        : [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }],
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        {
          label: '文档',
          click: () => { void shell.openExternal(DOCS_URL) },
        },
        // macOS already carries this in the application menu above.
        ...process.platform === 'darwin'
          ? []
          : [{ type: 'separator' as const }, { label: '检查更新…', click: onCheckForUpdates }],
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
