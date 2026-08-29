#!/usr/bin/env node
import { DEFAULT_HOST, DEFAULT_PORT, MixingStationClient } from './mixingstation.js';
import { ParameterDiscovery } from './discovery.js';
import { MsMcpGateway } from './msmcp-gateway.js';
import { runMsMcpServer } from './msmcp-server.js';

function usage(): void {
	console.error('Usage: npm start -- [--host HOST] [--port PORT]');
}

function portValue(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port must be an integer between 1 and 65535');
	return port;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let host = DEFAULT_HOST;
	let port = DEFAULT_PORT;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--help') { usage(); return; }
		if (argument === '--host' || argument === '--port') {
			const value = args[index + 1];
			if (value === undefined) throw new Error(`${argument} requires a value`);
			index += 1;
			if (argument === '--host') host = value;
			else port = portValue(value);
			continue;
		}
		throw new Error(`unknown option: ${argument}`);
	}

	const client = new MixingStationClient({ host, port });
	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		client.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await client.connect();
	const parameters = await new ParameterDiscovery(client).discover();
	if (parameters.length === 0) {
		client.close();
		throw new Error('no parameters discovered — is Mixing Station running and connected to a mixer?');
	}
	// Diagnostics go to stderr: stdout carries the MCP JSON-RPC stream.
	console.error(`msmcp: connected to ${client.url}, discovered ${parameters.length} parameters`);
	const gateway = new MsMcpGateway(client, parameters);
	// server.connect() resolves as soon as the stdio transport starts, so the
	// process stays alive via the transport; the client is closed when the MCP
	// session ends (transport close) or on SIGINT/SIGTERM.
	await runMsMcpServer(gateway, () => client.close());
}

main().catch((error: unknown) => {
	console.error(`msmcp startup error: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
