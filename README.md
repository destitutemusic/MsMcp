# MsMcp

MsMcp is an MCP server for Mixing Station with dynamic parameter discovery and
control. Forked from the ConsoleMCP TypeScript implementation. User-editable
mapping profiles live in `profiles/`:

```sh
cd /home/hermes2/MsMcp/msmcp
npm install
npm test
npm run build
```

Run it against a console with the compiled entry point:

```sh
node dist/src/main.js \
  --profile profiles/x32-m32.json \
  --host 192.168.1.50 \
  --port 10023
```

The MCP server uses JSON-RPC over stdin/stdout. Use the direct `node` command
above when configuring an MCP client; npm's `run` wrapper prints a banner to
stdout, which would corrupt the MCP stream. Diagnostics are written to stderr.

The available tools are generated from the selected profile, alongside the
generic `console.list_commands`, `console.call`, `console.batch`,
`console.snapshot`, `console.restore`, and gated `console.raw_osc` tools.
Pass `--allow-raw-osc` only for a trusted MCP client.
