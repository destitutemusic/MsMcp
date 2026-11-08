# ConsoleMCP TypeScript — Architecture Summary

Clone: `https://github.com/bulyaki/ConsoleMCP.git` → `/home/hermes2/MsMcp/ConsoleMCP`
Studied: `typescript/` implementation (the repo also contains a C++ port at `src/*.cpp`, `include/consolemcp/`; this document covers the TypeScript implementation only).

ConsoleMCP is a stdio MCP server that exposes digital-mixing-console control as
MCP tools. It is console-agnostic by design: a declarative JSON **mapping
profile** (the "profile") supplies the console's command vocabulary and OSC
addresses; the code supplies command semantics (get/set/action), typed value
validation, transforms, and the OSC codec. A profile can add commands with no
code change.

---

## 1. File structure

```
typescript/
  package.json          # ESM ("type":"module"), Node >= 20, deps: @modelcontextprotocol/server, zod v4
  tsconfig.json         # ES2022 / NodeNext, strict, noUncheckedIndexedAccess; src/ + test/ compile to dist/
  src/
    main.ts     (1.9 KB)   # CLI entry: arg parse, profile load, transport construction, wiring
    server.ts   (5.6 KB)   # MCP adapter: McpServer init, tool/resource registration, JSON-RPC layer
    mapping.ts (25.8 KB)   # Profile engine: types, loader/validator, schema gen, address expansion, value transforms
    gateway.ts (11.0 KB)   # Command adapter: tool-call → OSC message, rate limiting, snapshot/restore, raw OSC
    osc.ts      (7.5 KB)   # OSC codec + UDP transport (encode/decode, OscTransport interface)
  test/
    consolemcp.test.ts (8.7 KB)  # node:test suite; MockTransport; in-memory MCP client/server round trips
profiles/
  x32-m32.json          # Behringer X32/M32 baseline profile (port 10023)
  wing.json             # Behringer WING profile, verified firmware 3.1 (port 2223)
```

Module dependency direction (no cycles):

```
main.ts → mapping.ts, osc.ts, server.ts, gateway.ts
server.ts → gateway.ts, mapping.ts (types only), @modelcontextprotocol/server
gateway.ts → mapping.ts, osc.ts (types only)
mapping.ts → osc.ts (MAX_OSC_PACKET_SIZE, OscValue type)
osc.ts → node:dgram only
```

---

## 2. Key modules and responsibilities

### `main.ts` — CLI entry point
- Parses `--profile FILE [--host HOST] [--port PORT] [--allow-raw-osc]`.
- `MappingCatalog.fromFile(profilePath)` loads + validates the profile;
  `catalog.overrideTransport(host, port)` applies CLI overrides.
- Constructs the concrete `UdpOscTransport` **here** (not in the gateway) from
  `catalog.profile.transport` — the single wiring point where a different
  transport would be substituted.
- `runStdioServer(new ConsoleGateway(catalog, transport, allowRawOsc))`.
- Startup errors → `console.error` + exit code 1.

### `server.ts` — MCP adapter (only place that knows JSON-RPC)
- `createServer(gateway)`: `McpServer` named `ConsoleMCP` v`0.1.0`,
  capabilities `tools.listChanged` + `resources.listChanged`.
- Five fixed tools:
  - `console.list_commands` — `gateway.catalog.commandsJson()`
  - `console.call` — `{command, arguments}` → `gateway.execute`
  - `console.batch` — 1–128 `{command, arguments}` calls, in order
  - `console.snapshot` — reads profile-configured snapshot commands
  - `console.restore` — replays a snapshot result
  - `console.raw_osc` — typed raw OSC, only when `--allow-raw-osc` set at startup
- One generated tool per profile command: `console.<id>`, whose zod input
  schema comes from `inputSchema(definition)` (zod built from the profile's
  type/min/max/enum; `value` added for `set` only; strict object — unknown
  keys rejected).
- Two resources: `console://profile` and `console://commands`
  (`application/json`).
- Every handler is wrapped in `safe(...)` → `success()` (text content +
  `structuredContent`) or `failure()` (`isError: true` + message text).
- `runStdioServer`: connects via `StdioServerTransport` — stdio JSON-RPC only,
  no HTTP/SSE.

### `mapping.ts` — profile engine
- **Types** (`MappingProfile`, `CommandDefinition`, `ArgumentDefinition`,
  `ValueDefinition`, `TransportSettings`, `SnapshotEntry`):
  - `CommandKind` = `'get' | 'set' | 'action'`; `ValueType` = string/integer/
    number/boolean/enum/trigger/blob.
  - `CommandDefinition.osc` = `{ get?, set?, action?, reply? }` address
    templates containing `{argumentName}` placeholders.
  - `ValueDefinition`: `type`, `oscType` (wire override), `min`/`max`, `unit`,
    `values` (enum), `replyIndex` (which reply argument carries the value —
    WING replies `,sff` display-string/normalized/native), `transform`
    (`{scale, offset}`, applied `wire = in*scale + offset`, inverted on read).
- **`MappingCatalog`** (static factories + instance):
  - `fromObject` — full profile validation: schemaVersion must be 1, id/name
    required, transport defaults (`host 127.0.0.1`, `port 10023`,
    `timeoutMs 250`, `rateLimitPerSecond 100`), duplicate-command-id check,
    snapshot command resolution (each snapshot cmd must be a `get` with an
    `osc.get`), size limits (profile ≤ 8 MiB, ≤ 4096 commands, ≤ 64 args,
    ≤ 256 enum values).
  - `fromFile` — `statSync` size check then `JSON.parse`.
  - `command(id)` — id → definition or "unknown console command" error.
  - `overrideTransport(host?, port?)` — CLI overrides.
  - `commandsJson()` / `toolSchema(def)` — MCP-facing JSON Schema per command.
  - `expandAddress` (static) — `{arg}` → validated value; integer args with
    `width` are zero-padded (`/ch/{channel}` width 2 → `/ch/01`);
    scalar args stringified; rejects `{`, `}`, NUL in output; result must
    start with `/` and be ≤ 1024 chars.
  - `validateArguments` (static) — every declared arg present, typed,
    in-range, enum member; no unknown keys.
  - `toOscValue` / `fromOscValue` (static) — JSON ↔ OSC typed value, applying
    transform forward/inverse; handles oscType overrides (e.g. WING ignores
    OSC `T`/`F`, so booleans go as `int`); `trigger` → OSC `nil`;
    `blob` → byte array.

### `gateway.ts` — command adapter (only place that turns commands into OSC)
- `ConsoleGateway(catalog, transport: OscTransport, allowRawOsc)`.
- `execute(commandId, input)` → validates → `makeMessage` (selects
  get/set/action template, `expandAddress`, `toOscValue`) → rate limit →
  transport call.
- `executeGet`: `transport.request(message, expected, timeoutMs)`; expected =
  `osc.reply` template if set, else the queried address. Reply value picked via
  `replyArgument` (clamped to last arg if shorter than `replyIndex`),
  decoded with `fromOscValue`. **Timeout → thrown error, never fake success.**
- `executeSetOrAction`: fire-and-forget `transport.send`; returns
  `{command, address, sent: true, arguments, value?}`.
- `consumeRateLimit` — **paces** (waits) rather than aborting, so a batch/
  restore is never half-applied.
- `batch` (1–128, sequential), `snapshot` (sequential reads of
  `profile.snapshotCommands`, each must return one mapped value),
  `restore` (entries must be `set` commands; replays captured value).
- `rawOsc` — gated by `allowRawOsc`; accepts scalars, byte arrays, or
  `{type, value}` objects; ≤ 64 args; 1024-char address.

### `osc.ts` — OSC codec + transport
- `OscValue` union (int/float/string/bool/nil/blob), `OscMessage`.
- `encodeOscMessage` / `decodeOscPacket` — full OSC 1.0 wire format
  (4-byte alignment, typetags `,i f s T F N b`, bundles, blob length+padding);
  rejects non-`/` addresses, > 65 507-byte packets, trailing bytes.
- **`OscTransport` interface** — the key seam:
  ```ts
  interface OscTransport {
    send(message: OscMessage): Promise<void>;
    request(message: OscMessage, expectedAddress: string, timeoutMs: number): Promise<OscMessage | null>;
  }
  ```
- `UdpOscTransport` — one shared `dgram` `udp4` socket; `request` registers a
  one-shot `message` listener, filters decoded messages by exact
  `expectedAddress` match (first match wins), resolves `null` on timeout.

### `test/consolemcp.test.ts` — test suite
- `node:test` + `node:assert/strict`, run as `npm test`
  (`tsc` build → `node --test dist/test/*.test.js`).
- `MockTransport` implements `OscTransport` (records sent messages, optional
  canned response / forced timeout) — transport is fully fakeable.
- In-memory MCP round trip via `@modelcontextprotocol/client` +
  `InMemoryTransport`: list tools, call `console.channel.fader.set` against the
  real x32 profile, read the `console://commands` resource.
- Covers: codec round trip, transform math (0.5 float ⇄ 50%), validation
  rejection, timeout errors, raw-OSC gating, `replyIndex` + short-reply clamp,
  rate-limiter pacing, `osc.reply` (query `/…/?`, reply on bare address).

---

## 3. Data flow: MCP client → console

```
JSON-RPC line (stdio)
   │  @modelcontextprotocol/server → McpServer dispatch
   ▼
server.ts handler for console.<id>
   │  zod input validation (strict)
   │  safe() → success/failure envelope
   ▼
ConsoleGateway.execute(id, args)
   │  1. catalog.command(id)        — unknown id → error, no packet
   │  2. validateArguments          — missing/extra/wrong-type/out-of-range → error, no packet
   │  3. makeMessage
   │        expandAddress: "/ch/{channel}/mix/fader" + {channel:2,width?} → "/ch/2/mix/fader"
   │        toOscValue:   value + transform → OSC typed argument
   │  4. consumeRateLimit           — paces to profile.rateLimitPerSecond
   ▼
OscTransport (UdpOscTransport)
   │  encodeOscMessage → dgram UDP send (host/port from profile, CLI overrides)
   ▼
   console
   │  set/action: fire-and-forget → ack JSON
   │  get: reply datagram → decodeOscPacket → filter by expected address
   ▼
gateway: fromOscValue (inverse transform, replyIndex select) → JsonObject
   ▼
server.ts: success() → { content:[{text: JSON}], structuredContent }
```

Command lifecycle (from `docs/architecture.md`): unknown id / invalid args →
error, **no packet**; valid → rate-limit wait (never aborts) → OSC send;
`get` with no matching reply → bounded timeout error, never fake success.

---

## 4. Extension points — replacing OSC with Mixing Station API

Mixing Station (MS) exposes a websocket/HTTP JSON API instead of OSC, so the
replacement is not a drop-in transport swap; the profile's OSC-specific
vocabulary and the reply model both need generalizing. The seams, in
dependency order:

1. **`OscTransport` interface (`osc.ts`) — the primary seam.** The gateway
   depends only on `send`/`request`. A `MixingStationTransport` implementing
   this interface (websocket client with request/response correlation, e.g.
   MS's `{"scope","channel","parameter","value"}` message format) plugs into
   `ConsoleGateway` with zero gateway changes. **Blocking issue:** `request`
   returns an `OscMessage` typed reply and matches by OSC address string.
   The reply side is OSC-shaped end to end (`replyArgument`,
   `fromOscValue`, `jsonForOscArguments`). Either:
   - a) keep `OscTransport` and have the MS transport synthesize `OscMessage`
     `{address, arguments: OscValue[]}` from MS replies (address = a synthetic
     key like the command id or a JSON path; arguments = value array) — keeps
     `replyIndex`/multi-arg reply logic intact; or
   - b) generalize the transport interface to return a neutral
     `unknown[]` value list (or a `ValueReply`) and push `fromOscValue`
     behind a per-value "reply codec". This is the cleaner end state but
     touches `gateway.ts` and every transport.

2. **`CommandDefinition.osc` (`mapping.ts`) — profile vocabulary.** Address
   templates, the leading-`/` check, and `oscType` are OSC-specific. A
   Mixing Station profile needs a parallel "wire mapping" per command — e.g.
   `api: { get, set, action }` where templates expand to MS request paths or
   JSON parameter keys. `expandAddress`'s `{arg}` substitution + width
   zero-padding logic is generic and reusable as-is; only the template
   syntax/validation constants (`startsWith('/')`, 1024-char limit) change.
   Bump `schemaVersion` (currently hard-`1`) and branch the parser on it, or
   keep schemaVersion 1 and add an optional `api` block alongside `osc`.

3. **`TransportSettings` (`mapping.ts` `fromObject`) — connection config.**
   Parses UDP-only fields (`host`, `port`, `timeoutMs`, `rateLimitPerSecond`)
   with OSC defaults (127.0.0.1:10023). MS needs websocket URL, reconnect/
   auth options. `overrideTransport(host, port)` and `--host/--port` CLI flags
   are UDP-shaped; a `--transport-type`/`--url` flag or a transport factory in
   `main.ts` replaces the direct `new UdpOscTransport(...)`.

4. **`main.ts` wiring point.** The only place a concrete transport is
   constructed. A factory (`transportFor(catalog.profile.transport)`) is the
   minimal-change insertion point.

5. **`console.raw_osc` tool + `--allow-raw-osc` (`server.ts`, `gateway.ts`,
   `main.ts`)** — OSC-specific escape hatch. For MS either becomes a raw
   JSON-passthrough tool or is dropped.

6. **Reusable as-is (transport-agnostic):** `MappingCatalog` validation and
   schema generation, `validateArguments`, `expandAddress` template engine,
   `transform` math, `replyIndex` semantics, rate limiter, `batch`,
   `snapshot`/`restore`, the `success`/`failure`/`isError` error envelope,
   zod input-schema builder, and the entire test harness (`MockTransport`
   proves the gateway needs only the 2-method interface).

7. **OSC-only constants to remove or move** (all in `mapping.ts`/`osc.ts`):
   `MAX_OSC_PACKET_SIZE = 65_507` (blob limit + codec guard), OSC typetag
   mapping, `oscType` field, `trigger→nil`, WING-style boolean-as-int
   handling (profile-level workaround; fine to keep).

---

## 5. Hardcoded assumptions (would need changing)

| # | Assumption | Where | Mixing Station impact |
|---|---|---|---|
| 1 | Wire protocol is OSC over UDP; socket is `udp4` `dgram`, unbound (replies arrive on the ephemeral source port) | `osc.ts`, `main.ts` | Replace with websocket/HTTP client |
| 2 | `get` replies are matched by **exact OSC address string equality**; first matching message in a packet wins; no correlation ids | `osc.ts` `request` | MS needs request ids / subscription matching |
| 3 | Address templates must start with `/`, expand ≤ 1024 chars | `mapping.ts` `validateTemplate`/`expandAddress` | MS request keys/paths differ |
| 4 | Transport defaults: host `127.0.0.1`, port `10023`, `timeoutMs 250`, `rateLimitPerSecond 100` | `mapping.ts` `fromObject` | MS URL/auth config |
| 5 | `schemaVersion` is exactly `1` | `mapping.ts` | Bump on profile-format change |
| 6 | `set`/`action` are fire-and-forget (no ack); success = UDP send succeeded | `gateway.ts` `executeSetOrAction` | MS often returns responses — could await real acks |
| 7 | `get` timeout → hard error (`OSC get timed out…`); never fake success | `gateway.ts` | Keep semantics, reword message |
| 8 | Tool namespace prefix `console.`; server name/version `ConsoleMCP`/`0.1.0`; resources `console://profile`, `console://commands` | `server.ts` | Cosmetic; MS variant may want its own names |
| 9 | Only stdio transport (`StdioServerTransport`) | `server.ts` | Keep unless HTTP/SSE needed |
| 10 | Rate limiter **paces** bursts rather than erroring (snapshot/restore half-apply hazard) | `gateway.ts` `consumeRateLimit` | Keep — transport-agnostic |
| 11 | Snapshot commands must be `get`-with-`osc.get` and return exactly one mapped value; restore entries must be `set` kind | `mapping.ts` ctor, `gateway.ts` | Same semantics for MS |
| 12 | `replyIndex` 0–15; short replies clamp to last argument | `mapping.ts`, `gateway.ts` `replyArgument` | Keep — generic multi-arg reply model |
| 13 | Value transform is linear `scale`/`offset` only | `mapping.ts` | Keep; MS may need nonlinear (e.g. dB tables) later |
| 14 | Hard limits: profile ≤ 8 MiB, 4096 commands, 64 args, 256 enum values, batch ≤ 128, raw args ≤ 64, blob ≤ 65 507 bytes | `mapping.ts`, `gateway.ts`, `osc.ts` | Recheck against MS message sizes |
| 15 | Profile is a single JSON file passed via `--profile`; no config file/daemon | `main.ts` | Keep or extend |
| 16 | Boolean wire type may be overridden via `oscType` (WING ignores OSC `T`/`F`) | `mapping.ts` `toOscValue` | MS booleans are native JSON — moot |
| 17 | WING-style multi-representation replies (`,sff`: display string, normalized, native) encoded as `replyIndex` | profiles, `gateway.ts` | MS returns one typed value — `replyIndex` degrades gracefully |

---

## 6. Build/test/run

```bash
cd typescript
npm install
npm run build        # tsc → dist/
npm test             # build + node --test dist/test/*.test.js
npm start -- --profile ../profiles/x32-m32.json [--host HOST] [--port PORT] [--allow-raw-osc]
```

No runtime dependencies beyond `@modelcontextprotocol/server` and `zod`;
Node ≥ 20 required.
