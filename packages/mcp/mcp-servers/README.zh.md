---
description: "面向用户与维护者的 settings 托管 MCP 服务器宿主说明：不改 patch 文件即可增删外部工具服务器。"
kind: "package-reference"
---

# `@deepseek-ai/dsh-mcp-servers`

[English](README.md) | 中文

## 概述

由设置驱动的 [MCP](https://modelcontextprotocol.io/) 服务器管理。它按 `mcp-servers` 设置区段中的每个条目挂载一个 [`mcp-client`](../mcp-client/README.zh.md) 实例，因此增删一个服务器是一次设置编辑，而不是一次组合编辑。

## 目录

- [为什么需要它](#why-this-exists)
- [配置](#config)
- [调谐](#reconciliation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="why-this-exists"></a>
## 为什么需要它

MCP 服务器是一个插件实例，而不是一个值。直接添加一个意味着往组合里写入一行：

```yaml
- id: mcp-filesystem
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: filesystem
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/docs']
```

这要求一个人在添加工具服务器之前先知道三件彼此独立的事：该改哪个文件、这个文件用的是什么补丁方言、以及那个插件的包名。本包把这三件事收敛为一份服务器列表，于是任何设置界面都能像编辑其他设置一样编辑它。

部署自带的服务器仍以各自的组合行存在，不受本包影响；它只拥有自己设置区段里的条目。

<a id="config"></a>
## 配置

| 字段 | 必填 | 说明 |
|---|---|---|
| `servers` | 否 | 受管的服务器。为空（默认）时不挂载任何东西。 |

每个条目包含 `name`（工具命名空间 —— 模型看到的是 `mcp__<name>__<tool>`）、`command`、`args` 和 `enabled`。

```yaml
- name: '@deepseek-ai/dsh-mcp-servers'
  config:
    servers:
      - name: filesystem
        command: npx
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/docs']
        enabled: true
```

同一份列表也是 `mcp-servers` 命名空间下的设置区段，因此上面的组合条目是部署默认值，而使用者在「设置」里编辑生效中的列表。被禁用的条目会保留但不运行 —— 这正是一个人得以「暂时停用某个服务器、又不丢失那条查了半天才找到的命令」的前提。

<a id="reconciliation"></a>
## 调谐

每次设置变更都会把已挂载的集合与列表对齐。命令未变的条目继续运行 —— 编辑一个服务器绝不会重启其他服务器。命令变了的条目会被卸载并重新挂载，且先等待卸载完成：MCP 服务器可能持有某种独占资源（端口、锁、设备），而同一个服务器的两代实例重叠，是本管理器自己造成的冲突。多次调谐被串行化，因此两次快速编辑不会都基于同一份过期视图行事。

挂载失败的服务器会被记录并从已挂载集合中移除，而不会拖垮管理器或其他服务器。`mcp-client` 自己负责连接重试；能到达这里的是被拒绝的挂载，例如 `serverName` 与某个组合行重名。

<a id="model-experience"></a>
## Model Experience

### 受管的工具服务器

#### 模型看到什么

工具，位于 `mcp__<name>__<tool>` 之下，与手工组合该服务器时完全一致 —— 本包改变的是服务器列表写在哪里，而不是已连接的服务器发布什么。命名契约由 `mcp-client` 拥有。

会话中途新增的服务器会把工具加入下一次请求；被移除的则相应撤走。除了工具列表的变化之外，两者都不会另行告知模型。

#### Token 影响

本包自身没有。每个已挂载服务器的工具 schema 占用请求的工具列表，那笔账由 `mcp-client` 交代。

#### KV Cache 影响

改动列表会改变工具 schema，而它位于被缓存的前缀中：变更后的第一个请求是一次未命中。稳态不受影响，因此一份改过一次便不再改动的列表，在那一个请求之后不再有任何代价。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **仅支持 stdio** —— HTTP 型 MCP 服务器仍需一行组合的 `mcp-client`。`serverName`、`env`、`cwd`、超时与重连策略同样只属于组合层；受管条目在这些方面一律采用 `mcp-client` 的默认值。
- **本包不提供连接状态** —— 受管服务器是否真的连上了，要通过 Loader 的插件清单和日志查看，而不是通过本包。因此设置界面报告的是「配置了什么」，而非「谁在服务」。
- **挂载失败不会回报给引发它的界面** —— 保存一个命令写错的服务器会成功；失败随后出现在日志里。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作上下文 —— 点击展开</summary>

本开发备注不具权威性，只是维护者的工作笔记与开放问题。已交付的行为与已接受的理由在上面各节、包代码以及关联的 Agent Note 中。

- 被弃用的设计是「提供一套读写 patch 行的 API 再在其上做界面」。既然 MCP server 本身**就是**一个插件实例，让一个管理插件持有它们，比教一个设置界面去编辑 patch 文件简单得多，也复用了现成的 settings 与卡片框架。
- 调谐时命令未变的条目继续运行；变了的先 `await dispose()` 再挂载替代者。名字是同步释放的 —— `await` 买到的是**旧子进程先退出**，因为一个 MCP server 可能持有端口、锁或设备。
- 只支持 stdio。`env`、`cwd` 与 HTTP 传输仍需组合层的 `mcp-client` 行。本包不提供连接状态，需要从 Loader 的插件清单读取。

</details>
