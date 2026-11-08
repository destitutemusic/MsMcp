# MsMcp — Research Document

## Project Goal

Refactor ConsoleMCP (MCP server for digital mixing consoles over OSC) to work with Mixing Station's unified API, creating a single MCP server that can control **any mixer Mixing Station supports** (60+ models from 10+ manufacturers).

---

## 1. ConsoleMCP — What It Is

**Repository:** https://github.com/bulyaki/ConsoleMCP
**License:** Apache 2.0
**Implementations:** C++20 and TypeScript/Node (interchangeable)

### Architecture

```
MCP client (Claude, Codex, ChatGPT, your app)
    │ JSON-RPC 2.0 over stdio
    ▼
MCP command adapter ── generated tools/resources
    │ named command + JSON arguments
    ▼
Mapping/profile engine ── user-editable command catalog
    │ OSC address + typed values
    ▼
Console gateway ── validation, rate limiting, serialized access
    │ one UDP OSC session
    ▼
Digital mixer console
```

### Key Concepts

- **Profile-driven:** Adding a console command = editing a JSON profile, not recompiling
- **Profiles define:** OSC addresses, argument types/ranges, value transforms, command groups, snapshot membership
- **Two kinds of commands:** `get` (read value) and `set` (write value), plus `action` (scene recall)
- **Snapshot/restore:** Save and restore subsets of console state (capped at 128 entries)
- **Generic tools:** `console.list_commands`, `console.call`, `console.batch`, `console.snapshot`, `console.restore`, `console.raw_osc`
- **Generated tools:** One MCP tool per profile command, named `console.<command id>`

### Current Profiles

| Profile | Console | Default Port | Notes |
|---|---|---|---|
| `x32-m32.json` | Behringer X32/M32 | UDP 10023 | Faders normalized 0.0–1.0, pan -1…+1 |
| `wing.json` | Behringer WING | UDP 2223 | Faders native dB (-144…+10), pan -100…+100 |

### CLI Options

```
--profile FILE    Mapping profile to load (required)
--host HOST       Override profile's OSC host
--port PORT       Override profile's OSC UDP port
--allow-raw-osc   Enable console.raw_osc
```

### Profile JSON Structure

```json
{
  "name": "wing",
  "description": "Behringer WING",
  "transport": {
    "host": "192.168.1.50",
    "port": 2223,
    "timeoutMs": 400,
    "rateLimitPerSecond": 100
  },
  "commands": [
    {
      "id": "channel.fader.set",
      "description": "Set channel fader level",
      "group": "channel",
      "kind": "set",
      "osc": { "set": "/ch/{ch}/mix/fader", "get": "/ch/{ch}/mix/fader" },
      "arguments": {
        "ch": { "type": "integer", "min": 1, "max": 40 }
      },
      "value": { "type": "float", "min": -144, "max": 10 },
      "replyIndex": 2
    }
  ],
  "snapshotCommands": [...]
}
```

### Discovery Tools (Recent Addition)

- `identify.py` — what console is at this IP
- `discover.py` — ask it what it has, write an inventory
- `profilegen.py` — inventory → command definitions
- `repair_profile.py` — check profile against hardware, fix what a reply proves
- `mock_console.py` — spec-faithful DiGiCo and Yamaha stand-ins

---

## 2. Mixing Station — What It Is

**Website:** https://mixingstation.app/
**Platforms:** iOS, Android, Desktop (Win/Mac/Linux)
**APIs:** REST (HTTP/Websockets), OSC (UDP) — **Desktop version only**

### Supported Mixers (60+ models)

| Manufacturer | Models |
|---|---|
| Allen&Heath | Avantis, CQ, GLD, Qu, SQ, SQ+, dLive, iLive |
| Behringer | Wing, X/M AIR, X32/M32 |
| Blackmagic | Fairlight Live |
| Mackie | DL series |
| Midas | HD96-24 |
| PreSonus | StudioLive III series |
| QSC | TouchMix |
| Soundcraft | Si, Ui, Vi series |
| TASCAM | Sonicview |

### REST API

**Endpoint:** `http://localhost:<port>` (configurable in global settings)

**Websocket JSON schema:**
```json
{ "path": "/app/state", "method": "GET", "body": null }
```

**Response:**
```json
{ "path": "/app/state", "method": "GET", "body": {}, "error": null }
```

### OSC API

**Protocol:** OSC via UDP (no bundles)

**Syntax:**
- Get: `/con/[vn]/{dataPath}` (no parameters)
- Set: `/con/[vn]/{dataPath} <type> <value>`
- Subscribe: `/hi/v` or `/hi/n` (send every 5s)

**Value formats:**
- `v` = plain value (e.g., -5 dB)
- `n` = normalized (0-1)

**Examples:**
```
/con/v/ch.0.mix.lvl          → get fader ch1 as dB
/con/n/ch.0.mix.lvl          → get fader ch1 as normalized
/con/v/ch.0.mix.lvl f -5     → set fader ch1 to -5dB
/con/n/ch.0.mix.lvl f 0.5    → set fader ch1 to 50%
```

### Parameter Path Convention

```
ch.{index}.mix.lvl          → channel fader level
ch.{index}.mix.mute         → channel mute
ch.{index}.eq.{band}.freq   → EQ frequency
ch.{index}.eq.{band}.gain   → EQ gain
ch.{index}.eq.{band}.q      → EQ Q
bus.{index}.mix.lvl         → bus fader level
dca.{index}.mix.lvl         → DCA fader level
```

### Metering (Websocket only)

```json
{
  "path": "/console/metering2/subscribe",
  "method": "POST",
  "body": {
    "id": 0,
    "interval": 100,
    "binary": true,
    "params": [{ "type": 0, "index": 0 }]
  }
}
```

**Metering types:**
- 0: Channel mixer meters (input/output levels)
- 1: Channel + Gate/Dyn SC Input and GR
- 10: RTA
- 11: RF channel meters

### Scene Management

- Get current state in MS Scene format
- Recall scenes with progress tracking
- Scene recall is asynchronous — monitor state changes

### App State

- Top state: high-level indicator (e.g., connected, disconnected)
- Bottom state: detailed status
- Automatically reported via websockets at `/app/state`

---

## 3. Key Differences: ConsoleMCP vs Mixing Station API

| Aspect | ConsoleMCP | Mixing Station API |
|---|---|---|
| **Protocol** | Direct OSC over UDP | REST/Websocket (HTTP) or OSC over UDP |
| **Parameter model** | Per-profile JSON mapping | Unified path model (`ch.0.mix.lvl`) |
| **Value format** | Per-profile (dB or normalized) | Choice: plain (dB) or normalized |
| **MCP integration** | Native MCP server | None (needs wrapping) |
| **Discovery** | Profile-driven (must know addresses) | Dynamic (API explorer auto-discovers) |
| **Metering** | Not implemented | Full metering API |
| **Scene management** | Snapshot/restore (128 cap) | Full scene recall with progress |
| **Supported mixers** | X32/M32, WING (+ DiGiCo/Yamaha mocks) | 60+ models from 10+ manufacturers |

---

## 4. Architecture for MsMcp

### Option A: Wrap Mixing Station's REST/Websocket API

```
MCP client
    │ JSON-RPC 2.0 over stdio
    ▼
MsMcp Server
    │ HTTP/Websocket
    ▼
Mixing Station Desktop
    │ OSC/proprietary
    ▼
Digital mixer
```

**Pros:**
- Mixing Station handles all mixer-specific protocol details
- Unified parameter model — one profile works for ALL mixers
- Access to metering, scene management, app state
- No need to reverse-engineer mixer protocols

**Cons:**
- Requires Mixing Station Desktop running as middleware
- Latency: MCP → HTTP → Mixing Station → OSC → mixer
- Licensing: Mixing Station Desktop is commercial software

### Option B: Wrap Mixing Station's OSC API

```
MCP client
    │ JSON-RPC 2.0 over stdio
    ▼
MsMcp Server
    │ OSC over UDP
    ▼
Mixing Station Desktop
    │ OSC/proprietary
    ▼
Digital mixer
```

**Pros:**
- Lower latency than HTTP
- Simpler protocol (OSC vs HTTP/Websocket)
- Mixing Station handles mixer-specific details

**Cons:**
- Still requires Mixing Station Desktop
- OSC API less documented than REST
- No metering (OSC doesn't support subscriptions well)

### Option C: Hybrid — Use Mixing Station for Discovery, Direct OSC for Control

```
MCP client
    │ JSON-RPC 2.0 over stdio
    ▼
MsMcp Server
    │ HTTP (discovery) + OSC (control)
    ▼
Mixing Station Desktop (discovery) + Mixer (direct control)
```

**Pros:**
- Best of both worlds: dynamic discovery + low-latency control
- Can work without Mixing Station (fallback to direct OSC)

**Cons:**
- Most complex architecture
- Two connections to manage

---

## 5. Recommended Approach: Option A (REST/Websocket)

### Why REST/Websocket over OSC?

1. **Auto-discovery:** The REST API explorer lists ALL available parameters — no profile generation needed
2. **Subscriptions:** Websocket subscriptions give real-time updates without polling
3. **Metering:** Full metering API available
4. **Scene management:** Built-in scene recall with progress tracking
5. **App state:** Monitor connection status

### Implementation Plan

1. **TypeScript/Node implementation** (quicker to iterate, better HTTP/Websocket libraries)
2. **Connect to Mixing Station Desktop** via REST/Websocket API
3. **Auto-generate MCP tools** from Mixing Station's parameter tree
4. **Expose generic tools:** `mixer.list_parameters`, `mixer.get`, `mixer.set`, `mixer.subscribe`, `mixer.scene.recall`, `mixer.metering`
5. **Expose generated tools:** One MCP tool per parameter (e.g., `mixer.channel.1.fader.set`)

### Parameter Mapping

Mixing Station's parameter paths map directly to MCP tools:

| MS Parameter Path | MCP Tool | Kind |
|---|---|---|
| `ch.{n}.mix.lvl` | `mixer.channel.{n}.fader.set` / `.get` | set/get |
| `ch.{n}.mix.mute` | `mixer.channel.{n}.mute.set` / `.get` | set/get |
| `ch.{n}.eq.{b}.freq` | `mixer.channel.{n}.eq.{b}.frequency.set` / `.get` | set/get |
| `bus.{n}.mix.lvl` | `mixer.bus.{n}.fader.set` / `.get` | set/get |
| `dca.{n}.mix.lvl` | `mixer.dca.{n}.fader.set` / `.get` | set/get |

### CLI Options

```
--host HOST       Mixing Station Desktop host (default: localhost)
--port PORT       Mixing Station REST API port (default: 8080)
--allow-metering  Enable metering subscription tools
--allow-raw-osc   Enable raw OSC passthrough
```

---

## 6. Open Questions

1. **Mixing Station licensing:** Does the REST/OSC API require a paid license? (Desktop version is commercial)
2. **Parameter enumeration:** How does the REST API expose the full parameter tree? Is it paginated?
3. **Subscription limits:** Are there limits on concurrent websocket subscriptions?
4. **Thread safety:** Is Mixing Station's API thread-safe for concurrent reads/writes?
5. **Error handling:** What error codes does the API return for invalid parameters?
6. **Rate limiting:** Are there API rate limits we need to respect?

---

## 7. Next Steps

1. Clone ConsoleMCP and study the TypeScript implementation
2. Get Mixing Station Desktop running and explore the REST API
3. Map Mixing Station's parameter tree to MCP tool definitions
4. Implement the MCP server wrapping Mixing Station's API
5. Test with a real mixer (or Mixing Station's demo mode)
