/**
 * The update check as the desktop shell runs it: fetch the release feed, offer
 * what it found, download in the background, and hand the installer to the
 * operating system.
 *
 * Kept apart from `./updater.ts` so the decisions in that module — which
 * version is newer, which asset installs here — stay testable without an
 * Electron runtime. This module is the part that talks to the network, the
 * disk, and the person.
 * @module @deepseek-ai/dsh-desktop/update-flow
 */

import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import {
  downloadBase,
  feedUrl,
  resolveUpdate,
  type AvailableUpdate,
  type ReleaseDocument,
} from './updater.ts'

/** Diagnostic prefix, matching the rest of the desktop shell. */
const NAME = 'dsh-desktop'

/**
 * How long a feed request may take.
 *
 * A person on a network that cannot reach github.com must not wait on a socket
 * that will never answer: the automatic check is invisible, so a hung request
 * would simply mean the feature silently never works.
 */
const FEED_TIMEOUT_MS = 10_000

/** How long the installer download may stall before it is abandoned. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

/** Copy shown to the person. Chinese first: this shell ships a zh-first UI. */
const COPY = {
  available: (version: string) => `发现新版本 ${version}`,
  availableDetail: '现在下载吗？下载完成后会提示你安装。',
  download: '下载',
  later: '稍后',
  install: '立即安装',
  downloaded: (version: string) => `新版本 ${version} 已下载完成`,
  downloadedDetail: '点击「立即安装」打开安装包。安装程序会提示你关闭本应用。',
  current: '已是最新版本',
  currentDetail: (version: string) => `当前版本 ${version} 已经是最新的。`,
  failed: '检查更新失败',
  failedDetail: '无法连接到更新服务器，请稍后再试，或前往发布页手动下载。',
  openPage: '打开发布页',
  noAsset: (version: string) => `新版本 ${version} 不提供当前平台的安装包`,
  noAssetDetail: '可以前往发布页查看其他下载方式。',
  cancel: '取消',
} as const

/**
 * Read the release feed.
 * @param url - the feed to read.
 * @returns the parsed release document.
 * @throws when the request fails, times out, or answers a non-OK status.
 */
async function fetchRelease(url: string): Promise<ReleaseDocument> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    headers: {
      // GitHub serves the documented shape only to a caller that asks for it,
      // and rejects a request carrying no user agent at all.
      'accept': 'application/vnd.github+json',
      'user-agent': `${NAME}/${app.getVersion()}`,
    },
  })
  if (!response.ok) throw new Error(`${NAME}: update feed answered ${String(response.status)}`)
  return await response.json() as ReleaseDocument
}

/**
 * Download one installer into a fresh temporary directory.
 *
 * A directory of its own, never a shared temp path: the file keeps the asset's
 * published name so the person recognizes what they are opening, and a private
 * directory is what keeps that name free without overwriting anything.
 * @param update - the update whose asset to fetch.
 * @param window - window whose taskbar progress reflects the download.
 * @returns the downloaded file's path.
 * @throws when the request fails or answers a non-OK status.
 */
async function downloadInstaller(update: AvailableUpdate, window: BrowserWindow | undefined): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-update-'))
  const target = join(directory, update.assetName)
  try {
    const response = await fetch(update.downloadUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok || response.body === null) {
      throw new Error(`${NAME}: installer download answered ${String(response.status)}`)
    }
    const total = update.size ?? Number(response.headers.get('content-length') ?? 0)
    let received = 0
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    if (total > 0 && window !== undefined && !window.isDestroyed()) {
      source.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (!window.isDestroyed()) window.setProgressBar(Math.min(received / total, 1))
      })
    }
    await pipeline(source, createWriteStream(target))
    return target
  } catch (error: unknown) {
    // The partial file is worthless and its directory is ours alone, so both go.
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    if (window !== undefined && !window.isDestroyed()) window.setProgressBar(-1)
  }
}

/** Whether a check is running, so a menu click during one cannot start a second. */
let running = false

/**
 * Run one update check.
 *
 * `interactive` is the whole difference between the two entry points. The
 * automatic check reports only what it found — an app that cannot reach the
 * feed on launch says nothing, because the person did not ask. A check from the
 * menu answers every outcome, including "already current" and "could not
 * connect", because a menu item that sometimes does nothing visible reads as
 * broken.
 * @param window - the main window, for taskbar progress and dialog ownership.
 * @param interactive - whether the person asked for this check.
 */
export async function checkForUpdates(window: BrowserWindow | undefined, interactive: boolean): Promise<void> {
  if (running) return
  running = true
  try {
    const current = app.getVersion()
    let update: AvailableUpdate | undefined
    try {
      const release = await fetchRelease(feedUrl())
      update = resolveUpdate(release, current, process.platform, process.arch, downloadBase())
    } catch (error: unknown) {
      // Not reaching the feed is ordinary on a filtered or offline network, so
      // the automatic pass keeps it to the log.
      console.warn(`${NAME}: update check failed: %o`, error)
      if (interactive) {
        const answer = await dialog.showMessageBox({
          type: 'warning',
          message: COPY.failed,
          detail: COPY.failedDetail,
          buttons: [COPY.openPage, COPY.cancel],
          defaultId: 1,
          cancelId: 1,
        })
        if (answer.response === 0) await shell.openExternal('https://github.com/SHILUNKA/deepseek-harness-desktop/releases')
      }
      return
    }

    if (update === undefined) {
      if (interactive) {
        await dialog.showMessageBox({
          type: 'info',
          message: COPY.current,
          detail: COPY.currentDetail(current),
          buttons: ['OK'],
        })
      }
      return
    }

    if (update.downloadUrl === '') {
      // A release exists but ships nothing for this platform and architecture.
      const answer = await dialog.showMessageBox({
        type: 'info',
        message: COPY.noAsset(update.version),
        detail: COPY.noAssetDetail,
        buttons: [COPY.openPage, COPY.cancel],
        defaultId: 0,
        cancelId: 1,
      })
      if (answer.response === 0 && update.releaseUrl !== undefined) await shell.openExternal(update.releaseUrl)
      return
    }

    const offer = await dialog.showMessageBox({
      type: 'info',
      message: COPY.available(update.version),
      detail: COPY.availableDetail,
      buttons: [COPY.download, COPY.later],
      defaultId: 0,
      cancelId: 1,
    })
    if (offer.response !== 0) return

    let installer: string
    try {
      installer = await downloadInstaller(update, window)
    } catch (error: unknown) {
      console.warn(`${NAME}: update download failed: %o`, error)
      const answer = await dialog.showMessageBox({
        type: 'warning',
        message: COPY.failed,
        detail: COPY.failedDetail,
        buttons: [COPY.openPage, COPY.cancel],
        defaultId: 0,
        cancelId: 1,
      })
      if (answer.response === 0 && update.releaseUrl !== undefined) await shell.openExternal(update.releaseUrl)
      return
    }

    const ready = await dialog.showMessageBox({
      type: 'info',
      message: COPY.downloaded(update.version),
      detail: COPY.downloadedDetail,
      buttons: [COPY.install, COPY.later],
      defaultId: 0,
      cancelId: 1,
    })
    // Handed to the OS rather than run by this app: opening a .dmg, an .exe
    // installer, or an .AppImage is the person's own gesture, and this app is
    // not signed to perform an unattended replacement of itself.
    if (ready.response === 0) await shell.openPath(installer)
  } finally {
    running = false
  }
}
