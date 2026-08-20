# `@deepseek-ai/dsh-mcp-servers`

English | [中文](README.zh.md)

Settings-driven [MCP](https://modelcontextprotocol.io/) server management. It mounts one [`mcp-client`](../mcp-client/README.md) instance per entry in the `mcp-servers` settings section, so gaining or losing a server is a settings edit rather than a composition edit.

## Why this exists

An MCP server is a plugin instance, not a value. Adding one directly means putting a row into the composition:

```yaml
- id: mcp-filesystem
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: filesystem
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/docs']
```

That asks a person to know three separate things before they can add a tool server: which file to edit, the patch dialect it is written in, and the package name of the plugin. This package reduces all three to one list of servers, which a settings surface can then edit like any other setting.

Servers a deployment ships stay composed as their own rows and are untouched by this package; it owns only the entries in its own settings section.

## Config

| Field | Required | Description |
|---|---|---|
| `servers` | no | The managed servers. Empty (the default) mounts nothing. |

Each entry carries `name` (the tool namespace — the model sees `mcp__<name>__<tool>`), `command`, `args`, and `enabled`.

```yaml
- name: '@deepseek-ai/dsh-mcp-servers'
  config:
    servers:
      - name: filesystem
        command: npx
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/docs']
        enabled: true
```

The same list is a settings section under the `mcp-servers` namespace, so the composition entry above is the deployment default and a person edits the live list from Settings. A disabled entry is kept but not run, which is what lets someone park a server without losing the command it took them a search to find.

## Reconciliation

Every settings change reconciles the mounted set against the list. An entry whose command is unchanged keeps running — editing one server never restarts the others. An entry whose command changed is unmounted and remounted, and the unmount is awaited first: an MCP server may hold something exclusive (a port, a lock, a device), and two generations of one server overlapping is a conflict this manager would have caused. Reconciles are serialized, so two rapid edits cannot both act on one stale view.

A server that fails to mount is logged and dropped from the mounted set rather than taking down the manager or the other servers. `mcp-client` owns its own connection retries; what reaches here is a refused mount, such as a duplicate `serverName` colliding with a composed row.

## Model Experience

### Managed tool servers

#### What the model sees

Tools, under `mcp__<name>__<tool>`, exactly as if the server had been composed by hand — this package changes where the server list is written, not what a connected server publishes. `mcp-client` owns the naming contract.

A server gained mid-session adds its tools to the next request; one removed takes them away. Neither is announced to the model beyond the changed tool list.

#### Token effect

None of its own. Each mounted server's tool schemas occupy the request's tool list, which is `mcp-client`'s account to answer for.

#### KV Cache effect

Changing the list changes the tool schemas, which sit in the cached prefix: the first request after a change is a cache miss. Steady state is unaffected, so a list edited once and left alone costs nothing after that request.

## Known Limitations and Deferred Work

- **stdio only** — an HTTP MCP server still needs a composed `mcp-client` row. `serverName`, `env`, `cwd`, timeouts, and the reconnect policy are likewise composition-only; managed entries take `mcp-client`'s defaults for all of them.
- **No connection status of its own** — whether a managed server actually connected is visible through the Loader's plugin inventory and the log, not through this package. A settings surface therefore reports what was configured, not what is serving.
- **A failed mount is not reported to the surface that caused it** — saving a server whose command is wrong succeeds; the failure appears in the log afterwards.
