# Third-party components

This project is licensed under Apache-2.0 (see `LICENSE`). It contains code derived from the
projects below, and depends at runtime on three packages. Attribution for the derived code is
also carried verbatim in `NOTICE`.

## Vendored or derived source

| Component | Licence | Copyright | What we use |
| --- | --- | --- | --- |
| [ConsoleMCP](https://github.com/bulyaki/ConsoleMCP) | Apache-2.0 | Copyright 2026 Code Pro Quo Ltd trading as Sonus Immersivus | Four modules are vendored **byte-identical** into `src/`: `gateway.ts`, `mapping.ts`, `osc.ts`, `server.ts`. `src/main.ts` is **modified** (host/port CLI, wiring to discovery and the MsMcp gateway). |

The upstream ConsoleMCP repository is not published here and is not required to build or run
this package; it is kept only as a development reference.

## Runtime dependencies

Versions are the ones resolved in `package-lock.json`.

| Package | Version | Licence |
| --- | --- | --- |
| `@modelcontextprotocol/server` | 2.0.0 | MIT |
| `ws` | 8.21.3 | MIT |
| `zod` | 4.4.3 | MIT |

## Development dependencies

| Package | Version | Licence |
| --- | --- | --- |
| `@modelcontextprotocol/client` | 2.0.0 | MIT |
| `@types/node` | 26.4.0 | MIT |
| `@types/ws` | 8.18.1 | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |

## Not affiliated

This project is not affiliated with, endorsed by, or supported by Mixing Station, Code Pro Quo
Ltd, or Sonus Immersivus. "Mixing Station" is used only to describe what this software talks to.
