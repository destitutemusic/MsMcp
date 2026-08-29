import { MappingCatalog } from './mapping.js';
import { UdpOscTransport } from './osc.js';
import { runStdioServer } from './server.js';
import { ConsoleGateway } from './gateway.js';

function usage(): void {
  console.error('Usage: npm start -- --profile FILE [--host HOST] [--port PORT] [--allow-raw-osc]');
}

function portValue(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port must be an integer between 1 and 65535');
  return port;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let profilePath: string | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let allowRawOsc = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') { usage(); return; }
    if (argument === '--allow-raw-osc') { allowRawOsc = true; continue; }
    if (argument === '--profile' || argument === '--host' || argument === '--port') {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--profile') profilePath = value;
      else if (argument === '--host') host = value;
      else port = portValue(value);
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (profilePath === undefined) { usage(); process.exitCode = 2; return; }

  const catalog = MappingCatalog.fromFile(profilePath);
  catalog.overrideTransport(host, port);
  const transport = new UdpOscTransport(catalog.profile.transport.host, catalog.profile.transport.port);
  await runStdioServer(new ConsoleGateway(catalog, transport, allowRawOsc));
}

main().catch((error: unknown) => {
  console.error(`ConsoleMCP TypeScript startup error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
