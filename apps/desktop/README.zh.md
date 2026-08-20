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

## 其他模型服务商

服务商属于用户设置，不属于 composition：[`llm-pi-ai`](../../packages/llm/llm-pi-ai/README.md) 适配器以零 route 的休眠状态挂载，一旦设置文档描述了某个 route，它便立即注册。因此桌面应用自身不内置任何服务商清单 —— 由 Models 设置页添加，profile 写入 `settings.yaml`，密钥经 `credentials.set` 写入，因此没有任何密钥进入配置文件。

多个国内服务商已存在于适配器的内置目录中，只需填写密钥；添加流程按 route id 提供它们：

| 服务商 | Route id |
|---|---|
| 通义千问（阿里） | `qwen-token-plan-cn` |
| 智谱 GLM | `zai-coding-cn`、`zai` |
| 月之暗面 Kimi | `moonshotai-cn`、`kimi-coding` |
| MiniMax | `minimax-cn`、`minimax` |
| DeepSeek | `deepseek` |

内置目录未收录的服务商在同一页面的「自定义设置」中声明，需填写显示名称、API 协议与 base URL —— 火山方舟（豆包）即属此类：协议为 `openai-completions`，base URL 为 `https://ark.cn-beijing.volces.com/api/v3`，模型 id 使用在其控制台创建的推理接入点 ID，而非公开模型名。请以服务商自身文档核对端点与模型 id；它们按服务商的节奏变更，与本仓库无关。

## 把工作分散到多个账号

上面若干服务商都提供每日或每月的免费额度，而单个额度往往撑不满一天的工作。[`llm-failover`](../../packages/llm/llm-failover/README.md) 插件正为此组合在这里：当某个服务商报告额度耗尽时，请求交由列表中的下一个来服务，而不是直接失败；耗尽的那个路由会被跳过一小时，之后重新成为首选。

列表在有人填写之前是空的，填写位置为**设置 → 插件 → 提供方故障转移**，格式是以逗号分隔的 `提供方/模型` 组合。没有配置密钥的服务商会被跳过而非尝试，因此列表里可以写上比任何单个用户实际注册的更多的服务商。而被*拒绝*的密钥不会被跳过 —— 那是配置错误，它会响亮地失败，而不是被悄悄绕开。

## MCP 服务器

外部 [MCP](https://modelcontextprotocol.io/) 工具服务器在**设置 → 插件 → MCP 服务器**中添加，每行一个，格式为 `名称: 命令 参数`。[`mcp-servers`](../../packages/mcp/mcp-servers/README.md) 插件会随列表变化挂载与卸载它们，因此增删一个服务器既不需要重启应用，也不需要编辑配置文件。行首加 `#` 可保留某个服务器而不运行它。

只有 stdio 型服务器能以这种方式配置。HTTP 型的 MCP 服务器，或需要环境变量、工作目录的服务器，仍然需要在 `cordis.patch.yml` 中组合一行 [`mcp-client`](../../packages/mcp/mcp-client/README.md)。

## Model Experience

无，本包是 Web 界面之外的桌面外壳；此处没有任何内容进入模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## 已知限制与未尽事项

- **profile 本地插件无法加载** —— 用户通过 `dsh plugin add` 安装的插件位于 profile 自己的 `node_modules` 中，只有 Loader 的原生辅助模块才能把该位置作为解析基准。该模块在 Electron 中无法工作，因此这里只能使用随安装发布的插件。CLI 不受影响。
- **无代码签名与公证** —— 安装包未签名，macOS Gatekeeper 与 Windows SmartScreen 会告警。签名身份属于发布流水线，不属于本脚本。
- **无自动更新** —— 更新意味着安装新构建。
- **启动时会先挂载整棵插件树，窗口才可用**，因此首屏要等待 profile 启动完成，而不是先显示部分 UI。
