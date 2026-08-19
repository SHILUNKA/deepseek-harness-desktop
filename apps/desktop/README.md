# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The desktop application: an Electron shell around one in-process `web` profile host, so the browser UI runs without a browser and without a command line. [`src/host.ts`](src/host.ts) boots the profile, [`src/main.ts`](src/main.ts) owns window and process lifetime.

The renderer is the shipped web frontend, unmodified. It reaches the host over the loopback HTTP and WebSocket routes a browser would use, so this app owns no product surface of its own.

## What it boots

The same `web` profile `dsh web` boots, from the same `@deepseek-ai/dsh` installation: a person's `cordis.patch.yml` layers apply identically on both surfaces. The one invocation difference is `--port 0` — the OS assigns a free loopback port and the window is handed the resulting URL, so no port is ever user-facing and a second instance cannot collide with a running `dsh web`.

## Shell behavior

| Behavior | Rule |
|---|---|
| Second launch | Reaches the running window; never boots a second host over the same session storage. |
| Closing the last window | Quits on every platform, macOS included. The host is a full agent runtime, and keeping it behind a closed window would leave an invisible process holding the session store. |
| Quit | Disposes the plugin tree first, bounded by a 5-second timeout so a wedged plugin cannot strand the exit. |
| Links to elsewhere | Open in the person's own browser, never in a chrome-less Electron window. |
| Startup failure | Reported in a dialog **and** on stderr — a double-clicked app has no console, a terminal launch has no dialog. |
| Window geometry | Remembered per machine in `userData`, and discarded when it no longer lands on a connected display. |

## Running from a checkout

```sh
pnpm run desktop        # links the runtime, then starts the app
```

`desktop:link` is required before a source-tree run and after any `pnpm install`. Electron cannot use the Loader's native helper for bare plugin specifiers — `node-addon-require-builtin` reaches Node's internal ESM loader through V8 embedder data, which Chromium owns in an Electron process — so the Loader falls back to plain ESM resolution from its own module under `vendor/`, whose pnpm-strict `node_modules` holds no plugins. [`scripts/link-electron-runtime.ts`](../../scripts/link-electron-runtime.ts) restores that reachability; a packaged build gets it from the flat deployed closure instead.

## Packaging

```sh
node --import tsx/esm scripts/build-desktop.ts [--platform mac|win|linux]
```

Run it directly, **not** through `pnpm run`: `pnpm deploy` refuses to run beneath another pnpm process and would target the workspace instead of the staging tree. The script deploys a flat closure, restores the packages the deploy omits, and invokes electron-builder; [`scripts/build-desktop.ts`](../../scripts/build-desktop.ts) documents why each step exists. Installers land in `dist-desktop/out`.

Packaging requires `asar: false`. `healProfilesModuleFallback` symlinks installed packages into `~/.dsh/profiles/node_modules`, and the operating system resolves those links; a target inside an asar archive is not a real filesystem path, so every one of them would dangle.

## Other model providers

Providers are user settings, not composition: the [`llm-pi-ai`](../../packages/llm/llm-pi-ai/README.md) adapter is mounted dormant with zero routes, and a route registers the moment the settings document describes it. The desktop app therefore ships no provider list of its own — the Models settings page adds one, writing the profile to `settings.yaml` and the key through `credentials.set`, so no secret enters a configuration file.

Several China-hosted providers are already in the adapter's installed catalog and only need a key; the add flow offers them by route id:

| Provider | Route id |
|---|---|
| Qwen (Alibaba) | `qwen-token-plan-cn` |
| Zhipu GLM | `zai-coding-cn`, `zai` |
| Moonshot Kimi | `moonshotai-cn`, `kimi-coding` |
| MiniMax | `minimax-cn`, `minimax` |
| DeepSeek | `deepseek` |

A provider the catalog does not ship is declared in the same page under 自定义设置, which asks for the display name, the API protocol, and the base URL — Volcengine Ark (Doubao) is one of these: protocol `openai-completions`, base URL `https://ark.cn-beijing.volces.com/api/v3`, and a model id that is the inference endpoint id created in its console rather than a public model name. Verify endpoints and model ids against the provider's own documentation; they change on the provider's schedule, not this repository's.

## Model Experience

None, as the package is a desktop shell around the web surface; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Profile-local plugins do not load** — plugins a person installs with `dsh plugin add` live in the profile's own `node_modules`, which only the Loader's native helper can resolve as a base. That helper cannot work in Electron, so only plugins shipped with the installation are available here. The CLI is unaffected.
- **No code signing or notarization** — installers are unsigned, so macOS Gatekeeper and Windows SmartScreen will warn. Signing identities belong to a release pipeline, not to this script.
- **No auto-update** — updating means installing a new build.
- **Startup mounts the whole tree before the window becomes usable**, so first paint waits on the profile boot rather than showing partial UI.
