/**
 * Update checking for the packaged desktop application: ask the release feed
 * what the newest version is, download that platform's installer, and hand it
 * to the operating system.
 *
 * The app installs nothing itself. A silent in-place replacement needs a signed
 * and notarized bundle on macOS, which these artifacts are not, so the last
 * step is the person double-clicking an installer they can see — the same
 * gesture that installed the app in the first place. Everything before that
 * step is automated, which is the part that actually costs a person attention.
 *
 * A check is best-effort and quiet by design. The release feed lives on
 * github.com, which a person on a slow or filtered network may not reach; a
 * failed check must never interrupt an app that is otherwise working, so the
 * automatic pass reports failure only to the log. A person who asks for a check
 * from the menu is told either way, because silence would read as a hang.
 * @module @deepseek-ai/dsh-desktop/updater
 */

/** The release feed this app checks, overridable for a mirror or a private channel. */
const DEFAULT_FEED = 'https://api.github.com/repos/SHILUNKA/deepseek-harness-desktop/releases/latest'

/**
 * Where the installers are fetched from.
 *
 * Split from the feed on purpose: the metadata is a few kilobytes and survives
 * a slow link, while the installer is hundreds of megabytes and is what a
 * mirror is actually for. A deployment that fronts its downloads with a CDN
 * overrides only this, and the feed keeps naming the canonical asset names.
 */
const DOWNLOAD_BASE_ENV = 'DSH_DESKTOP_UPDATE_DOWNLOAD_BASE'

/** Feed override, for a mirror of the release metadata itself. */
const FEED_ENV = 'DSH_DESKTOP_UPDATE_FEED'

/** One release asset as the feed reports it. */
export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
}

/** The subset of a release document this app reads. */
export interface ReleaseDocument {
  tag_name?: string
  name?: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
  html_url?: string
}

/** An update this app is prepared to install, resolved against the running platform. */
export interface AvailableUpdate {
  /** The release's version, with any leading `v` removed. */
  version: string
  /** Asset file name, which is also what the downloaded file is called. */
  assetName: string
  /** Where to fetch the installer, after any download-base override. */
  downloadUrl: string
  /** The release page, offered when no asset matches this platform. */
  releaseUrl: string | undefined
  /** Asset size in bytes when the feed reports one, for download progress. */
  size: number | undefined
}

/** One parsed semantic version. */
interface ParsedVersion {
  release: number[]
  prerelease: string[]
}

/**
 * Parse a semantic version into its comparable parts.
 *
 * Only the shape this repository actually ships is honoured — `0.1.2` and
 * `0.1.2-alpha.3` — and build metadata after `+` is dropped because semver
 * excludes it from precedence.
 * @param raw - the version, with or without a leading `v`.
 * @returns the release numbers and the dot-separated prerelease identifiers.
 */
function parseVersion(raw: string): ParsedVersion {
  const cleaned = raw.trim().replace(/^v/u, '').split('+')[0] ?? ''
  const [release = '', prerelease = ''] = cleaned.split('-', 2) as [string?, string?]
  return {
    release: release.split('.').map(part => Number.parseInt(part, 10) || 0),
    prerelease: prerelease === '' ? [] : prerelease.split('.'),
  }
}

/**
 * Compare two dot-separated prerelease identifier lists by semver precedence.
 *
 * An empty list outranks a non-empty one — `0.1.2` is newer than
 * `0.1.2-alpha.3` — and numeric identifiers compare as numbers so `alpha.10`
 * follows `alpha.9` rather than preceding it.
 * @param a - left identifiers.
 * @param b - right identifiers.
 * @returns negative when `a` precedes `b`, positive when it follows, else zero.
 */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // A version without a prerelease is the released one, and outranks any of its
  // own prereleases.
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNum = /^\d+$/u.test(left) ? Number.parseInt(left, 10) : undefined
    const rightNum = /^\d+$/u.test(right) ? Number.parseInt(right, 10) : undefined
    if (leftNum !== undefined && rightNum !== undefined) {
      if (leftNum !== rightNum) return leftNum - rightNum
      continue
    }
    // Mixed kinds: semver ranks a numeric identifier below an alphanumeric one.
    if (leftNum !== undefined) return -1
    if (rightNum !== undefined) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * Compare two versions by semantic-version precedence.
 * @param a - left version.
 * @param b - right version.
 * @returns negative when `a` is older, positive when newer, zero when equal.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < Math.max(left.release.length, right.release.length); i += 1) {
    const diff = (left.release[i] ?? 0) - (right.release[i] ?? 0)
    if (diff !== 0) return diff
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * The installer extensions worth installing on the running platform, most
 * preferred first — the format a person installs by double-clicking comes
 * before the archive.
 *
 * The extension is what identifies the platform, not any token inside the
 * name. electron-builder names each target by that target's own convention:
 * the shipped 0.1.0-rc.7 release carries `-macOS-arm64.dmg`, `-win-x64.exe`,
 * `-linux-x86_64.AppImage`, and `dsh-desktop_0.1.0-rc.7_amd64.deb` — differing
 * in case, in architecture spelling, in separator, and the .deb naming the
 * platform nowhere at all. Only one target per platform produces each of these
 * extensions, so matching on them holds without predicting those conventions.
 */
function platformExtensions(platform: NodeJS.Platform): string[] | undefined {
  if (platform === 'darwin') return ['.dmg', '.zip']
  if (platform === 'win32') return ['.exe']
  if (platform === 'linux') return ['.AppImage', '.deb']
  return undefined
}

/**
 * The architecture spellings one Node `process.arch` may appear as.
 *
 * Every one of these is observed in the shipped release: electron-builder
 * writes `x64` for the Windows and macOS targets, `x86_64` for AppImage, and
 * Debian's own `amd64` for the .deb.
 */
function archAliases(arch: string): string[] {
  if (arch === 'x64') return ['x64', 'x86_64', 'amd64']
  if (arch === 'arm64') return ['arm64', 'aarch64']
  return [arch]
}

/**
 * Pick the asset that installs on the running platform.
 *
 * The extension selects the platform and an architecture token selects the
 * build. Matching is case-insensitive and the token is bounded by a separator
 * or the extension's dot, so `-macOS-x64.dmg` is found while the neighbouring
 * `-macOS-arm64.dmg` is not mistaken for it.
 * @param assets - the release's assets.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the matching asset, or `undefined` when the release carries none.
 */
export function selectAsset(
  assets: readonly ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | undefined {
  const extensions = platformExtensions(platform)
  if (extensions === undefined) return undefined
  const aliases = archAliases(arch)
  const carriesArch = (name: string): boolean =>
    // Bounded on both sides: an unbounded `x64` would also match inside a
    // future `x64_v2`, and an unbounded `arm64` inside a version string.
    aliases.some(alias => new RegExp(`[-_.]${alias}[-_.]`, 'iu').test(name))
  for (const extension of extensions) {
    const hit = assets.find(asset =>
      asset.name.toLowerCase().endsWith(extension.toLowerCase()) && carriesArch(asset.name))
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Rewrite an asset URL onto a configured download base.
 *
 * The base replaces everything up to the file name, so a mirror only has to
 * serve the same file names under one prefix.
 * @param url - the feed's own download URL.
 * @param base - the configured base, if any.
 * @returns the URL to fetch from.
 */
export function resolveDownloadUrl(url: string, base: string | undefined): string {
  if (base === undefined || base.trim() === '') return url
  const name = url.split('/').pop() ?? ''
  return `${base.replace(/\/+$/u, '')}/${name}`
}

/**
 * Decide what a release document means for the running app.
 * @param document - the release as the feed reported it.
 * @param currentVersion - the running app's version.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @param downloadBase - configured download base, if any.
 * @returns the available update, or `undefined` when the app is current.
 */
export function resolveUpdate(
  document: ReleaseDocument,
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string,
  downloadBase?: string,
): AvailableUpdate | undefined {
  // A draft is not published to anyone; a prerelease is published but is not
  // what an ordinary install should be moved onto on its own.
  if (document.draft === true || document.prerelease === true) return undefined
  const tag = (document.tag_name ?? '').replace(/^desktop-v?/u, '').replace(/^v/u, '')
  if (tag === '') return undefined
  if (compareVersions(tag, currentVersion) <= 0) return undefined
  const asset = selectAsset(document.assets ?? [], platform, arch)
  return {
    version: tag,
    assetName: asset?.name ?? '',
    downloadUrl: asset === undefined ? '' : resolveDownloadUrl(asset.browser_download_url, downloadBase),
    releaseUrl: document.html_url,
    size: asset?.size,
  }
}

/** The feed this process checks, after any override. */
export function feedUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[FEED_ENV]
  return override === undefined || override.trim() === '' ? DEFAULT_FEED : override.trim()
}

/** The download base this process uses, after any override. */
export function downloadBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[DOWNLOAD_BASE_ENV]
  return override === undefined || override.trim() === '' ? undefined : override.trim()
}
