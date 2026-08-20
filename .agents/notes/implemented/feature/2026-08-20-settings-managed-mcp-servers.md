# Agent Note: Settings-managed MCP servers

Status: implemented

English | [中文](2026-08-20-settings-managed-mcp-servers.zh.md)

## Problem

An MCP server is a plugin instance, not a value, so adding one meant writing a row into the composition. For a person using the desktop app that is three separate things to learn before gaining a single tool server: which file to edit (`~/.dsh/cordis.patch.yml`, inside a dot-directory the Finder hides), the patch dialect it is written in, and the package name of the plugin to name in it. Nothing in the product mentioned that MCP was configurable at all — Settings offered Models, Plugins, and a read-only plugin list, and none of them could mount anything.

## Decision

`@deepseek-ai/dsh-mcp-servers` holds a list of servers in a settings section (`mcp-servers`) and mounts one `mcp-client` instance per enabled entry, reconciling on every change. Gaining or losing a server is a settings write; the composition is not involved, and neither is a restart.

Servers a deployment ships stay composed as their own rows and are untouched — the manager owns only its own section.

Reconciling unmounts before it mounts, and awaits each unmount. The name is released as the fiber disposes, so a replacement would not be refused either way; what the await buys is that the old child process is gone before its replacement spawns, since an MCP server may hold something exclusive. Passes are serialized, so two rapid edits cannot both act on one stale view of the mounted set.

A refused entry costs only itself. Schemastery validates as it constructs and `mcp-client` reserves its namespace during activation, so a refusal can arrive synchronously; caught, it is logged and skipped, and the rest of the pass proceeds. The manager also reconciles once on its own rather than only when told to, because `installSettingsSection` announces through a settings injection — a deployment that composes servers but mounts no settings provider would otherwise run none of them.

The browser half is a card under Settings → Plugins editing one line per server, `name: command arguments`, with `#` for an entry kept but not run.

## Alternatives considered

**A Host API that reads and writes MCP rows in `cordis.patch.yml`, with a settings page over it.** This was the original plan, and the patch-layer hot-reload landed for it (`feat(desktop): keep user patch layers live`). It was dropped once it became clear the manager could simply hold the instances: writing a patch dialect from a UI means owning a file format, an insert position, and a merge story, where mounting a plugin means owning a `Map`. The hot-reload remains correct and useful for hand edits; this path no longer needs it.

**A textarea rather than a row of controls per server.** A launch command is something people paste from a README in one piece, and a control-per-argument form makes them take it apart first. The row-per-server form is the eventual shape; the parse refuses malformed input rather than dropping servers, so the stored value stays trustworthy either way.

**Reporting connection status on the card.** Deferred. Whether a managed server actually connected is a Host fact this package does not surface; the Loader's plugin inventory answers it today. Adding a status channel is a separate change.

## Consequences

A person adds an MCP server without knowing that composition, patch files, or `@deepseek-ai/dsh-mcp-client` exist, and without restarting the app.

Cost: only stdio servers are configurable this way — HTTP servers, `env`, `cwd`, timeouts, and the reconnect policy remain composition-only, and managed entries take `mcp-client`'s defaults. The card reports what was configured, not what is serving, so a server whose command is wrong saves successfully and fails in the log afterwards. Changing the list changes the tool schemas, so the first request after an edit is a prefix-cache miss.

## Testing

`packages/mcp/mcp-servers/tests/managed-servers.spec.ts` runs a real stdio MCP server as a fixture and asserts through the tool registry: a settings write gains a server, a removal loses it, a disabled entry never runs, a changed command is replaced (the fixture names its tool after an argument, so a replacement that never mounted is observable), an unchanged entry keeps running while another is edited, a refused entry does not take the others down, and a composed list runs with no settings provider present. The last two cases each found a real defect — a synchronous refusal aborting the rest of the pass, and a composed list never receiving a first pass.
