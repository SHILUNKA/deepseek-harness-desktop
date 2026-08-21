/** Display names and key-issuing consoles for catalog provider routes. */

import type { ModelsKey } from './locales.ts'

/**
 * The catalog routes this page names. pi-ai's configurable directory answers a
 * route id and nothing else — `getBuiltinProviders()` returns the keys of its
 * model table — so a shipped provider reaches the page as `zai-coding-cn`, a
 * string that names neither the brand nor which of a brand's endpoints it is.
 *
 * A route absent from this table is not renamed. The table therefore grows with
 * the providers a person is likely to reach for rather than tracking every
 * route pi-ai ships, and a route the upstream catalog adds is never blocked by
 * its absence here.
 */
const CATALOG_NAMES: Readonly<Record<string, ModelsKey>> = {
  'deepseek': 'providerDeepseek',
  'ant-ling': 'providerAntLing',
  'zai': 'providerZai',
  'zai-coding-cn': 'providerZaiCodingCn',
  'minimax': 'providerMinimax',
  'minimax-cn': 'providerMinimaxCn',
  'moonshotai': 'providerMoonshotai',
  'moonshotai-cn': 'providerMoonshotaiCn',
  'kimi-coding': 'providerKimiCoding',
  'qwen-token-plan': 'providerQwenTokenPlan',
  'qwen-token-plan-cn': 'providerQwenTokenPlanCn',
  'xiaomi': 'providerXiaomi',
  'xiaomi-token-plan-cn': 'providerXiaomiTokenPlanCn',
  'xiaomi-token-plan-ams': 'providerXiaomiTokenPlanAms',
  'xiaomi-token-plan-sgp': 'providerXiaomiTokenPlanSgp',
}

/**
 * Resolve the name a provider row shows.
 *
 * The directory reports a route's *configured* name and falls back to the route
 * id when the profile carries none, so `displayName === provider` is exactly
 * the case where nothing named this route — a name of the person's own choosing
 * is never overridden, including one they deliberately set to the route id.
 * @param provider - the route id.
 * @param displayName - the name the directory reported for it.
 * @param t - the section's copy lookup.
 * @returns the name to show, which is the route id when nothing names it.
 */
export function resolveProviderName(
  provider: string,
  displayName: string,
  t: (key: ModelsKey) => string,
): string {
  if (displayName !== provider) return displayName
  const key = CATALOG_NAMES[provider]
  return key === undefined ? displayName : t(key)
}

/**
 * Where a person gets a key for a catalog route. The adapter knows the API
 * endpoint, which is not where a key is issued — `api.moonshot.cn` serves
 * requests while `platform.moonshot.cn` hands out the credential — so the page
 * carries its own table.
 *
 * An entry is the key page itself where that path is known to be the provider's
 * own published one, and the console root otherwise: a console reorganizes its
 * paths on its own schedule, and a link that 404s is worse than one more click.
 *
 * Kimi's two routes deliberately point at different sites. `platform.moonshot.cn`
 * redirects to `platform.kimi.com` and `platform.moonshot.ai` to
 * `platform.kimi.ai`, so the China and international routes each land on the
 * console that holds their own account — sending one to the other's site would
 * show a person a key page their key does not come from.
 *
 * Routes whose console could not be confirmed are absent, and absence simply
 * renders no link. Deliberately carries no free-tier amounts: those change on
 * the provider's schedule, and a stale promise in the UI is worse than none.
 */
const CATALOG_CONSOLES: Readonly<Record<string, string>> = {
  'deepseek': 'https://platform.deepseek.com/api_keys',
  'zai': 'https://z.ai',
  'zai-coding-cn': 'https://bigmodel.cn/apikey/platform',
  'minimax': 'https://www.minimax.io',
  'minimax-cn': 'https://platform.minimaxi.com',
  'moonshotai': 'https://platform.kimi.ai/console/api-keys',
  'moonshotai-cn': 'https://platform.kimi.com/console/api-keys',
  // Serves `api.kimi.com/coding`, so its account lives on the .com side.
  'kimi-coding': 'https://platform.kimi.com/console/api-keys',
  'qwen-token-plan-cn': 'https://bailian.console.aliyun.com',
  'xiaomi': 'https://platform.xiaomimimo.com',
  'xiaomi-token-plan-cn': 'https://platform.xiaomimimo.com',
  'xiaomi-token-plan-ams': 'https://platform.xiaomimimo.com',
  'xiaomi-token-plan-sgp': 'https://platform.xiaomimimo.com',
}

/**
 * The console that issues keys for a route, when one is known.
 * @param provider - the route id.
 * @returns the console URL, or undefined when this page knows of none.
 */
export function resolveProviderConsole(provider: string): string | undefined {
  return CATALOG_CONSOLES[provider]
}
