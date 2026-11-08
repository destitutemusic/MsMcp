# MsMcp

An **MCP server for Mixing Station**. It lets an AI client — Claude Desktop, Codex, ChatGPT, or any
other MCP-capable app — control a digital mixing console through Mixing Station Desktop's REST and
WebSocket API: it discovers every available parameter at startup, exposes them as MCP tools, and
applies your changes live.

## What you need

- **An MCP-capable client.** That is where the AI lives.
- **This package does NOT include an AI model.** MsMcp is the hands, not the brain: it has no
  language model, no API keys and makes no outbound calls anywhere except to your own Mixing
  Station instance on your machine. *(The sibling MixingStationCopilot project is the one that
  bundles a copilot; this is the small, shareable half.)*
- **Mixing Station Desktop**, running, connected to your mixer, with its HTTP REST API enabled.
  The server assumes `127.0.0.1:1234` by default; pass `--host` / `--port` if yours listens
  elsewhere. Nothing works until this is on — it is the first thing people hit.

## Install

```bash
npx msmcp
```

That is the whole install: the package has a `bin` entry `msmcp` → `dist/src/main.js`, so `npx`
downloads and runs it. To install it permanently, `npm install -g msmcp` and use `msmcp`.

Requires **Node.js ≥ 20**.

## Configure your client

Claude Desktop — edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`, Windows:
`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "msmcp": {
      "command": "npx",
      "args": ["-y", "msmcp", "--host", "127.0.0.1", "--port", "1234"]
    }
  }
}
```

Restart the client. For any other MCP client, register the same command — `npx -y msmcp` — as a
**stdio** server; the client-specific field names differ but the command does not. If you installed
globally, `"command": "msmcp"` with no `npx` args is the same thing.

## Discovering what it can do

You do not need a tool list from this README, and it would be wrong if we wrote one: the tools are
generated from **your** mixer, so they differ per console. Ask the client to call `tools/list` — or
just ask it in words — and it will enumerate the live set. The protocol version is negotiated at
handshake and the server identifies itself as `MsMcp` (version `0.1.0`); both are visible in the
`initialize` response.

## From source

```bash
git clone https://github.com/destitutemusic/MsMcp.git
cd MsMcp
npm ci
npm run build
node dist/src/main.js --host 127.0.0.1 --port 1234
```

`npm test` builds and runs the suite. Two mock servers under `mock/` let you develop without a
console: `node mock/mock-mixing-station.cjs` (REST, port 8081) and
`node mock/mock-mixing-station-ws.cjs` (WebSocket).

## Licence and attribution

Apache-2.0 — see `LICENSE`. This package vendors modules from **ConsoleMCP**, Copyright 2026
Code Pro Quo Ltd trading as Sonus Immersivus, under Apache-2.0; the required attribution is in
[`NOTICE`](NOTICE), and complete component and dependency licences are in
[`THIRD-PARTY.md`](THIRD-PARTY.md).

**Not affiliated with or endorsed by Mixing Station, Code Pro Quo Ltd, or Sonus Immersivus.**
"Mixing Station" is used only to describe the software this server talks to.
