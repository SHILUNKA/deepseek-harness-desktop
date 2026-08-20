import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { resolveProviderConsole, resolveProviderName } from '../src/client/provider-catalog.ts'

/** The section's real lookup, so a missing key fails here rather than rendering blank. */
const t = (key: keyof typeof en): string => en[key]

describe('catalog provider names', () => {
  it('names a catalog route the directory reported by id alone', () => {
    expect(resolveProviderName('zai-coding-cn', 'zai-coding-cn', t)).toBe('Zhipu GLM Coding (China)')
  })

  it('keeps a name the profile carries', () => {
    // A route in the table whose profile names it: the person's choice wins, or
    // renaming a provider on the settings page would silently do nothing.
    expect(resolveProviderName('deepseek', 'Acme Gateway', t)).toBe('Acme Gateway')
  })

  it('keeps the id of a route the table does not name', () => {
    expect(resolveProviderName('amazon-bedrock', 'amazon-bedrock', t)).toBe('amazon-bedrock')
  })

  it('serves every named route in both locales', () => {
    // A key present in `en` but missing from `zh` would render an English brand
    // name inside the Chinese page; the type only guarantees the key set.
    for (const key of Object.keys(en).filter(name => name.startsWith('provider'))) {
      expect(zh[key as keyof typeof en], key).toBeTruthy()
      expect(en[key as keyof typeof en], key).toBeTruthy()
    }
  })
})

describe('key-issuing consoles', () => {
  // Verified reachable when the table was written; each is a provider's own
  // console root, which is the claim this table makes.
  const CONSOLES: readonly (readonly [string, string])[] = [
    ['deepseek', 'https://platform.deepseek.com'],
    ['zai', 'https://z.ai'],
    ['zai-coding-cn', 'https://bigmodel.cn'],
    ['minimax', 'https://www.minimax.io'],
    ['minimax-cn', 'https://platform.minimaxi.com'],
    ['moonshotai', 'https://platform.moonshot.ai'],
    ['moonshotai-cn', 'https://platform.moonshot.cn'],
    ['kimi-coding', 'https://platform.moonshot.cn'],
    ['qwen-token-plan-cn', 'https://bailian.console.aliyun.com'],
    ['xiaomi', 'https://platform.xiaomimimo.com'],
    ['xiaomi-token-plan-cn', 'https://platform.xiaomimimo.com'],
    ['xiaomi-token-plan-ams', 'https://platform.xiaomimimo.com'],
    ['xiaomi-token-plan-sgp', 'https://platform.xiaomimimo.com'],
  ]

  it.each(CONSOLES)('sends %s to its own console', (provider, url) => {
    expect(resolveProviderConsole(provider)).toBe(url)
  })

  it('offers no console for a route the table does not cover', () => {
    expect(resolveProviderConsole('amazon-bedrock')).toBeUndefined()
  })

  it('names every route it offers a console for', () => {
    // A link with no name would read as an anonymous id offering a key page.
    for (const [provider] of CONSOLES) {
      expect(resolveProviderName(provider, provider, t), provider).not.toBe(provider)
    }
  })
})
