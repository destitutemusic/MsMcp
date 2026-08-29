# MsMcp

MCP server for Mixing Station — dynamic parameter discovery and real-time control of 60+ digital mixers supported by Mixing Station Desktop.

## What it does

MsMcp connects to Mixing Station Desktop via its REST/Websocket API, discovers all available mixer parameters at startup, and auto-generates MCP tools for each one. Use any MCP-compatible client (Claude Desktop, Cursor, etc.) to control your mixer with natural language.

## Requirements

- Node.js >= 20
- Mixing Station Desktop running and connected to a mixer
- MCP-capable client (Claude Desktop, Cursor, etc.)

## Install

npm install -g msmcp

Or run from source:

git clone https://github.com/destitutemusic/MsMcp.git
cd MsMcp/msmcp
npm install
npm run build

## Usage

Start the server (Mixing Station Desktop must be running first):

msmcp --host 127.0.0.1 --port 1234

Default host is 127.0.0.1, default port is 1234.

### Configure your MCP client

Add to your MCP client config (e.g. Claude Desktop claude_desktop_config.json):

```json
{
  "mcpServers": {
    "mixer": {
      "command": "msmcp",
      "args": ["--host", "127.0.0.1", "--port", "1234"]
    }
  }
}
```

### Available tools

MsMcp auto-generates tools for every parameter discovered on your mixer. Common tools include:

- mixer.ch.N.mix.lvl.get / .set — channel fader (dB)
- mixer.ch.N.mix.mute.get / .set — channel mute
- mixer.ch.N.mix.pan.get / .set — channel pan
- mixer.bus.N.mix.lvl.get / .set — bus fader
- mixer.dca.N.mix.lvl.get / .set — DCA fader

Fixed tools:
- mixer.list_parameters — list all discovered parameters
- mixer.get / mixer.set — read/write any parameter by path
- mixer.batch — batch multiple set operations
- mixer.scene.list — list saved scenes
- mixer.scene.get_current — get current scene
- mixer.scene.recall — recall a scene by index

### Example: control a channel fader

Ask your MCP client: "Set channel 1 fader to -10 dB"

The client calls mixer.ch.0.mix.lvl.set with value: -10.

## Troubleshooting

### "no parameters discovered"
Mixing Station Desktop is not running, or not connected to a mixer. Start Mixing Station Desktop and connect to your mixer before starting MsMcp.

### "Mixing Station client is not connected"
The WebSocket connection to Mixing Station dropped. MsMcp auto-reconnects; retry your request after a few seconds.

### Wrong port
Mixing Station Desktop's API port may differ. Open Mixing Station Desktop, go to Settings > API, and check the port number. Pass it with --port.

### Connection refused
Ensure Mixing Station Desktop is running on the same machine, or that firewall rules allow connections on the API port.

## Supported mixers

MsMcp works with any mixer supported by Mixing Station Desktop (60+ models including Behringer X AIR/X32/WING, Allen & Heath Qu/dLive, Midas M32, and many more).

## License

Apache-2.0. Mixing Station is a separate product by Philipp BodEin.
