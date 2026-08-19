# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

桌面应用：在 Electron 主进程内启动一个 `web` profile 宿主的外壳，让浏览器 UI 无需浏览器、也无需命令行即可运行。[`src/host.ts`](src/host.ts) 负责启动 profile，[`src/main.ts`](src/main.ts) 负责窗口与进程生命周期。

渲染进程加载的就是随包发布的 Web 前端，未做任何修改。它通过浏览器同样会用的环回 HTTP 与 WebSocket 路由访问宿主，因此本应用不拥有任何产品界面。

## 它启动什么

与 `dsh web` 完全相同的 `web` profile，且来自同一份 `@deepseek-ai/dsh` 安装：用户的 `cordis.patch.yml` 各层在两个界面上生效方式一致。唯一的调用差异是 `--port 0` —— 由操作系统分配一个空闲的环回端口，并把得到的 URL 交给窗口，因此端口从不暴露给用户，第二个实例也不会与正在运行的 `dsh web` 冲突。

## 外壳行为

| 行为 | 规则 |
|---|---|
| 二次启动 | 聚焦到已运行的窗口；绝不在同一份会话存储上启动第二个宿主。 |
| 关闭最后一个窗口 | 所有平台（含 macOS）都退出。宿主是完整的 agent 运行时，让它留在关闭的窗口背后会留下一个占用会话存储的隐形进程。 |
| 退出 | 先释放插件树，并以 5 秒超时兜底，使卡死的插件无法阻塞退出。 |
| 外部链接 | 在用户自己的浏览器中打开，绝不在无浏览器控件的 Electron 窗口中打开。 |
| 启动失败 | 同时通过对话框**和** stderr 报告 —— 双击启动的应用没有控制台，终端启动的进程没有对话框。 |
| 窗口几何位置 | 按机器记录在 `userData` 中；当它不再落在任何已连接的显示器上时丢弃。 |

## 从源码仓库运行

```sh
pnpm run desktop        # links the runtime, then starts the app
```

源码方式运行前、以及每次 `pnpm install` 之后都必须执行 `desktop:link`。Electron 无法使用 Loader 解析裸插件标识符的原生辅助模块 —— `node-addon-require-builtin` 依靠 V8 embedder data 访问 Node 内部 ESM loader，而在 Electron 进程中该区域由 Chromium 占据 —— 因此 Loader 退化为从自身位于 `vendor/` 下的模块出发做普通 ESM 解析，而那里 pnpm 严格结构的 `node_modules` 不含任何插件。[`scripts/link-electron-runtime.ts`](../../scripts/link-electron-runtime.ts) 恢复这种可达性；打包构建则由扁平的部署闭包提供。

## 打包

```sh
node --import tsx/esm scripts/build-desktop.ts [--platform mac|win|linux]
```

必须直接运行，**不要**通过 `pnpm run`：`pnpm deploy` 拒绝在另一个 pnpm 进程下运行，会把目标指向工作区而非暂存目录。该脚本部署扁平闭包、补齐部署遗漏的包，然后调用 electron-builder；每一步的原因记录在 [`scripts/build-desktop.ts`](../../scripts/build-desktop.ts) 中。安装包输出到 `dist-desktop/out`。

打包必须使用 `asar: false`。`healProfilesModuleFallback` 会把已安装的包符号链接到 `~/.dsh/profiles/node_modules`，而这些链接由操作系统解析；asar 归档内部的目标不是真实文件系统路径，那样每一个链接都会失效。

## Model Experience

无，本包是 Web 界面之外的桌面外壳；此处没有任何内容进入模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## 已知限制与未尽事项

- **profile 本地插件无法加载** —— 用户通过 `dsh plugin add` 安装的插件位于 profile 自己的 `node_modules` 中，只有 Loader 的原生辅助模块才能把该位置作为解析基准。该模块在 Electron 中无法工作，因此这里只能使用随安装发布的插件。CLI 不受影响。
- **无代码签名与公证** —— 安装包未签名，macOS Gatekeeper 与 Windows SmartScreen 会告警。签名身份属于发布流水线，不属于本脚本。
- **无自动更新** —— 更新意味着安装新构建。
- **启动时会先挂载整棵插件树，窗口才可用**，因此首屏要等待 profile 启动完成，而不是先显示部分 UI。
