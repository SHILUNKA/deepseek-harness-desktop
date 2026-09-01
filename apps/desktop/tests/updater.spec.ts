/**
 * The update check's decisions: which version is newer, which asset installs on
 * this machine, and which releases are offered at all.
 *
 * These are the parts that decide whether someone is moved onto a new build, so
 * they are tested away from the Electron runtime that performs the move.
 *
 * The asset names are the real ones, copied from the published
 * `desktop-v0.1.0-rc.7` release rather than invented here. They are the only
 * evidence available for what electron-builder actually writes on platforms
 * this repository cannot build locally, and they disagree with each other in
 * case, architecture spelling, and separator — which is exactly what the
 * matching has to survive.
 */

import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  downloadBase,
  feedUrl,
  resolveDownloadUrl,
  resolveUpdate,
  selectAsset,
  type ReleaseAsset,
} from '../src/updater.ts'

/** Build assets from names, as the feed reports them. */
function assets(...names: string[]): ReleaseAsset[] {
  return names.map(name => ({
    name,
    browser_download_url: `https://github.com/owner/repo/releases/download/desktop-v0.1.0-rc.7/${name}`,
  }))
}

/**
 * Assets as `artifactName` in scripts/build-desktop.ts now names them: every
 * installer carries its architecture.
 */
const RELEASE_ASSETS = assets(
  'dsh-desktop-0.1.3-linux-x64.AppImage',
  'dsh-desktop-0.1.3-linux-x64.deb',
  'dsh-desktop-0.1.3-mac-arm64.dmg',
  'dsh-desktop-0.1.3-mac-arm64.zip',
  'dsh-desktop-0.1.3-mac-x64.dmg',
  'dsh-desktop-0.1.3-mac-x64.zip',
  'dsh-desktop-0.1.3-win-x64.exe',
)

/**
 * What electron-builder produced for 0.1.2 before `artifactName` was set —
 * verbatim, from that release. Kept as a test subject because it is the reason
 * the setting exists: three of these name no architecture at all.
 */
const DEFAULT_NAMED_ASSETS = assets(
  'DeepSeek.Harness-0.1.2-arm64-mac.zip',
  'DeepSeek.Harness-0.1.2-arm64.dmg',
  'DeepSeek.Harness-0.1.2-mac.zip',
  'DeepSeek.Harness-0.1.2.AppImage',
  'DeepSeek.Harness-0.1.2.dmg',
  'DeepSeek.Harness.Setup.0.1.2.exe',
  'dsh-desktop_0.1.2_amd64.deb',
)

describe('version precedence', () => {
  it('orders release numbers before any prerelease tie-break', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.2', '0.1.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
  })

  it('ranks a release above its own prereleases', () => {
    // This is what keeps an alpha from being offered as an upgrade over the
    // finished version of the same number.
    expect(compareVersions('0.1.2', '0.1.2-alpha.3')).toBeGreaterThan(0)
    expect(compareVersions('0.1.2-alpha.3', '0.1.2')).toBeLessThan(0)
  })

  it('compares numeric prerelease identifiers as numbers', () => {
    // Lexical ordering would place alpha.10 before alpha.9 and strand anyone
    // running the tenth alpha.
    expect(compareVersions('0.1.2-alpha.10', '0.1.2-alpha.9')).toBeGreaterThan(0)
  })

  it('treats equal versions as equal, with or without a leading v', () => {
    expect(compareVersions('0.1.2', '0.1.2')).toBe(0)
    expect(compareVersions('v0.1.2', '0.1.2')).toBe(0)
  })
})

describe('choosing the installer for this machine', () => {
  it('separates the two macOS architectures', () => {
    // An Apple Silicon machine must never be handed the Intel build, and the
    // two names differ only in that one token.
    expect(selectAsset(RELEASE_ASSETS, 'darwin', 'arm64')?.name).toBe('dsh-desktop-0.1.3-mac-arm64.dmg')
    expect(selectAsset(RELEASE_ASSETS, 'darwin', 'x64')?.name).toBe('dsh-desktop-0.1.3-mac-x64.dmg')
  })

  it('prefers the double-clickable format over the archive', () => {
    // Both .dmg and .zip exist for each macOS architecture; the .dmg is the one
    // a person installs from.
    expect(selectAsset(RELEASE_ASSETS, 'darwin', 'arm64')?.name.endsWith('.dmg')).toBe(true)
    expect(selectAsset(RELEASE_ASSETS, 'linux', 'x64')?.name.endsWith('.AppImage')).toBe(true)
  })

  it('picks the Windows installer', () => {
    expect(selectAsset(RELEASE_ASSETS, 'win32', 'x64')?.name).toBe('dsh-desktop-0.1.3-win-x64.exe')
  })

  it('accepts the architecture spellings each target uses', () => {
    // AppImage writes x86_64 and Debian writes amd64 where Node says x64.
    // Requiring the literal `x64` found neither.
    expect(selectAsset(assets('dsh-desktop-0.1.3-linux-x86_64.AppImage'), 'linux', 'x64')).toBeDefined()
    expect(selectAsset(assets('dsh-desktop_0.1.3_amd64.deb'), 'linux', 'x64')).toBeDefined()
  })

  it('matches the platform token regardless of case', () => {
    // electron-builder writes `macOS`, not `macos`.
    expect(selectAsset(assets('dsh-desktop-0.1.3-macOS-arm64.DMG'), 'darwin', 'arm64')).toBeDefined()
  })

  it('does not read one architecture as another', () => {
    // `arm64` must not satisfy a search for `x64`, in either direction, and a
    // longer token must not be matched by its own suffix.
    expect(selectAsset(assets('dsh-desktop-0.1.3-mac-arm64.dmg'), 'darwin', 'x64')).toBeUndefined()
    expect(selectAsset(assets('dsh-desktop-0.1.3-mac-x64.dmg'), 'darwin', 'arm64')).toBeUndefined()
  })

  it('cannot identify an architecture the default naming omits', () => {
    // Why scripts/build-desktop.ts sets artifactName. electron-builder named
    // the 0.1.2 build without an architecture on Windows, on macOS x64, and on
    // the AppImage — arm64 alone got a suffix, so an Intel build differs from
    // an Apple Silicon one only by an absent token, which nothing can match on.
    expect(selectAsset(DEFAULT_NAMED_ASSETS, 'win32', 'x64')).toBeUndefined()
    expect(selectAsset(DEFAULT_NAMED_ASSETS, 'darwin', 'x64')).toBeUndefined()
    // Only the two that happen to carry one are found.
    expect(selectAsset(DEFAULT_NAMED_ASSETS, 'darwin', 'arm64')?.name).toBe('DeepSeek.Harness-0.1.2-arm64.dmg')
    expect(selectAsset(DEFAULT_NAMED_ASSETS, 'linux', 'x64')?.name).toBe('dsh-desktop_0.1.2_amd64.deb')
  })

  it('finds nothing when the release ships no build for this machine', () => {
    expect(selectAsset(RELEASE_ASSETS, 'darwin', 'ppc64')).toBeUndefined()
    expect(selectAsset(RELEASE_ASSETS, 'aix', 'x64')).toBeUndefined()
  })
})

describe('deciding whether to offer a release', () => {
  const base = {
    tag_name: 'desktop-v0.2.0',
    assets: RELEASE_ASSETS,
    html_url: 'https://example/releases/0.2.0',
  }

  it('offers a newer release with this platform’s installer', () => {
    const update = resolveUpdate(base, '0.1.2-alpha.3', 'darwin', 'arm64')
    expect(update?.version).toBe('0.2.0')
    expect(update?.assetName).toBe('dsh-desktop-0.1.3-mac-arm64.dmg')
    expect(update?.downloadUrl).toContain('mac-arm64.dmg')
  })

  it('offers nothing when the running version is current or newer', () => {
    expect(resolveUpdate(base, '0.2.0', 'darwin', 'arm64')).toBeUndefined()
    expect(resolveUpdate(base, '0.3.0', 'darwin', 'arm64')).toBeUndefined()
  })

  it('skips a draft and a prerelease', () => {
    // A prerelease is published but is not what an ordinary installation should
    // be moved onto; the release workflow marks alphas this way on purpose, and
    // GitHub's own `/releases/latest` withholds them for the same reason.
    expect(resolveUpdate({ ...base, draft: true }, '0.1.0', 'darwin', 'arm64')).toBeUndefined()
    expect(resolveUpdate({ ...base, prerelease: true }, '0.1.0', 'darwin', 'arm64')).toBeUndefined()
  })

  it('reads the version out of the tag prefix the workflow uses', () => {
    expect(resolveUpdate({ ...base, tag_name: 'desktop-v0.2.0' }, '0.1.0', 'win32', 'x64')?.version).toBe('0.2.0')
    expect(resolveUpdate({ ...base, tag_name: 'v0.2.0' }, '0.1.0', 'win32', 'x64')?.version).toBe('0.2.0')
  })

  it('still reports a release that carries no installer for this machine', () => {
    // Reported rather than hidden: the person is told a newer version exists
    // and is pointed at the release page, instead of the check saying nothing.
    const update = resolveUpdate(base, '0.1.0', 'darwin', 'ppc64')
    expect(update?.version).toBe('0.2.0')
    expect(update?.downloadUrl).toBe('')
    expect(update?.releaseUrl).toBe('https://example/releases/0.2.0')
  })

  it('offers nothing when the feed names no tag', () => {
    expect(resolveUpdate({ assets: RELEASE_ASSETS }, '0.1.0', 'darwin', 'arm64')).toBeUndefined()
  })
})

describe('redirecting downloads to a mirror', () => {
  const url = 'https://github.com/owner/repo/releases/download/desktop-v0.1.3/dsh-desktop-0.1.3-win-x64.exe'

  it('keeps the feed’s own URL when nothing is configured', () => {
    expect(resolveDownloadUrl(url, undefined)).toBe(url)
    expect(resolveDownloadUrl(url, '   ')).toBe(url)
  })

  it('moves the file name onto the configured base', () => {
    // A mirror only has to serve the same file names under one prefix, which is
    // what makes switching to a domestic CDN a configuration change.
    expect(resolveDownloadUrl(url, 'https://mirror.example/dsh'))
      .toBe('https://mirror.example/dsh/dsh-desktop-0.1.3-win-x64.exe')
    expect(resolveDownloadUrl(url, 'https://mirror.example/dsh/'))
      .toBe('https://mirror.example/dsh/dsh-desktop-0.1.3-win-x64.exe')
  })

  it('threads the configured base through the resolved update', () => {
    const update = resolveUpdate(
      { tag_name: 'desktop-v0.2.0', assets: RELEASE_ASSETS },
      '0.1.0', 'win32', 'x64', 'https://mirror.example/dsh',
    )
    expect(update?.downloadUrl).toBe('https://mirror.example/dsh/dsh-desktop-0.1.3-win-x64.exe')
  })
})

describe('feed configuration', () => {
  it('defaults to the published release feed', () => {
    expect(feedUrl({})).toContain('deepseek-harness-desktop/releases/latest')
    expect(downloadBase({})).toBeUndefined()
  })

  it('takes an override, ignoring a blank one', () => {
    expect(feedUrl({ DSH_DESKTOP_UPDATE_FEED: 'https://example/feed' })).toBe('https://example/feed')
    expect(feedUrl({ DSH_DESKTOP_UPDATE_FEED: '  ' })).toContain('deepseek-harness-desktop')
    expect(downloadBase({ DSH_DESKTOP_UPDATE_DOWNLOAD_BASE: 'https://m.example' })).toBe('https://m.example')
    expect(downloadBase({ DSH_DESKTOP_UPDATE_DOWNLOAD_BASE: '' })).toBeUndefined()
  })
})
