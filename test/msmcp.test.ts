import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { Client, InMemoryTransport as ClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport as ServerTransport } from '@modelcontextprotocol/server';

import { ParameterDiscovery } from '../src/discovery.js';
import { MsMcpGateway } from '../src/msmcp-gateway.js';
import { createMsMcpServer } from '../src/msmcp-server.js';
import { MixingStationClient } from '../src/mixingstation.js';

interface MockState {
	http: HttpServer;
	wss: WebSocketServer;
	values: Map<string, unknown>;
	port: number;
}
function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve) => {
		let raw = '';
		req.setEncoding('utf8');
		req.on('data', (chunk: string) => {
			raw += chunk;
		});
		req.on('end', () => {
			try {
				resolve(raw.length === 0 ? undefined : JSON.parse(raw));
			} catch {
				resolve(undefined);
			}
		});
	});
}

/**
 * In-process Mixing Station stand-in. Unlike the client test mock, GET on an
 * unknown path replies with an error — discovery treats error replies as
 * "parameter does not exist".
 */
function startMock(initial: Record<string, unknown>): Promise<MockState> {
	return new Promise((resolve) => {
		const values = new Map(Object.entries(initial));
		const http = createServer(async (req, res) => {
			const url = req.url ?? '';
			if (url === '/app/state') {
				res.setHeader('content-type', 'application/json');
				res.end('{}');
				return;
			}
			const match = /^\/console\/data\/(get|set)\/(.+)\/val$/.exec(url);
			if (match) {
				const action = match[1]!;
				const dataPath = decodeURIComponent(match[2]!);
				if (action === 'set' && dataPath === 'scene.recall') {
					const body = await readJsonBody(req);
					let index: unknown = null;
					if (body !== null && typeof body === 'object' && 'value' in body && body.value !== null && typeof body.value === 'object' && 'index' in body.value) {
						index = body.value.index;
					}
					values.set('scene.current', index);
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ format: 'val', value: index }));
					return;
				}
				if (!values.has(dataPath)) {
					res.statusCode = 404;
					res.end('{"error":"not found"}');
					return;
				}
				if (action === 'get') {
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ format: 'val', value: values.get(dataPath) }));
					return;
				}
				const body = await readJsonBody(req);
				const value = typeof body === 'object' && body !== null && 'value' in body ? body.value : undefined;
				values.set(dataPath, value);
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ format: 'val', value }));
				return;
			}
			res.statusCode = 404;
			res.end('{}');
		});
		const wss = new WebSocketServer({ server: http });
		wss.on('connection', (socket) => {
			socket.on('message', (data) => {
				const request = JSON.parse(data.toString()) as { path: string; method: string; body?: unknown };
				const dataPath = request.path.replace(/^\/console\/data\//, '');
				const reply = (body: unknown, error: string | null = null) => {
					socket.send(JSON.stringify({ path: request.path, method: request.method, body, error }));
				};
				if (dataPath === 'subscribe') {
					reply(null);
					let pattern = 'unknown';
					if (request.body !== null && typeof request.body === 'object' && 'path' in request.body) {
						pattern = String(request.body.path);
					}
					const concrete = pattern.replace('*', '0');
					if (values.has(concrete)) {
						socket.send(JSON.stringify({ path: `/console/data/${concrete}`, method: 'POST', body: values.get(concrete), error: null }));
					}
					return;
				}
				if (dataPath === 'unsubscribe') {
					reply(null);
					return;
				}
			});
		});
		http.listen(0, '127.0.0.1', () => {
			resolve({ http, wss, values, port: (http.address() as { port: number }).port });
		});
	});
}

async function withClient(
	t: { after: (fn: () => void | Promise<void>) => void },
	initial: Record<string, unknown>,
	run: (state: MockState, client: MixingStationClient) => Promise<void>,
): Promise<void> {
	const state = await startMock(initial);
	const client = new MixingStationClient({ host: '127.0.0.1', port: state.port, timeoutMs: 2000 });
	t.after(() => {
		client.close();
		state.wss.close();
		state.http.close();
	});
	await client.connect();
	await run(state, client);
}

const MOCK_MIXER = {
	'ch.0.mix.lvl': -5,
	'ch.0.mix.mute': false,
	'ch.1.mix.lvl': 0.5,
	'bus.0.mix.lvl': -10,
	'dca.0.mix.lvl': -3,
	'scene.list': ['Scene 1', 'Scene 2', 'Sound Check'],
	'scene.current': 0,
};

test('discovery finds existing parameters with correct metadata and skips unknown paths', async (t) => {
	await withClient(t, MOCK_MIXER, async (state, client) => {
		const parameters = await new ParameterDiscovery(client).discover();
		assert.deepEqual(parameters.map((p) => p.path), ['ch.0.mix.lvl', 'ch.0.mix.mute', 'ch.1.mix.lvl', 'bus.0.mix.lvl', 'dca.0.mix.lvl']);

		const fader = parameters.find((p) => p.path === 'ch.0.mix.lvl')!;
		assert.equal(fader.type, 'float');
		assert.equal(fader.label, 'Channel 1 Fader');
		assert.equal(fader.unit, 'dB');
		assert.equal(fader.group, 'channels');
		assert.equal(fader.canGet, true);
		assert.equal(fader.canSet, true);

		const mute = parameters.find((p) => p.path === 'ch.0.mix.mute')!;
		assert.equal(mute.type, 'bool');
		assert.equal(mute.label, 'Channel 1 Mute');
		assert.equal(mute.unit, undefined);

		const bus = parameters.find((p) => p.path === 'bus.0.mix.lvl')!;
		assert.equal(bus.label, 'Bus 1 Fader');
		assert.equal(bus.group, 'buses');

		const dca = parameters.find((p) => p.path === 'dca.0.mix.lvl')!;
		assert.equal(dca.label, 'DCA 1 Fader');
		assert.equal(dca.group, 'dcas');
	});
});

test('discovery throws when the client is not connected', async () => {
	const client = new MixingStationClient({ host: '127.0.0.1', port: 1, timeoutMs: 50 });
	await assert.rejects(() => new ParameterDiscovery(client).discover(), /not connected/);
});

test('gateway get/set/batch round-trip values through the mock', async (t) => {
	await withClient(t, MOCK_MIXER, async (state, client) => {
		const parameters = await new ParameterDiscovery(client).discover();
		const gateway = new MsMcpGateway(client, parameters);

		assert.deepEqual(await gateway.get('ch.0.mix.lvl'), { path: 'ch.0.mix.lvl', value: -5 });
		assert.deepEqual(await gateway.set('ch.1.mix.lvl', 0.75), { path: 'ch.1.mix.lvl', value: 0.75, sent: true });
		assert.equal(state.values.get('ch.1.mix.lvl'), 0.75);

		assert.deepEqual(gateway.getParameter('ch.0.mix.lvl')?.group, 'channels');
		assert.equal(gateway.getParameter('ch.99.mix.lvl'), undefined);
		assert.equal(gateway.getParameters().length, parameters.length);

		const batch = await gateway.batch([
			{ path: 'ch.0.mix.lvl', value: 0.1 },
			{ path: 'ch.99.mix.lvl', value: 5 },
			{ path: 'bus.0.mix.lvl', value: -6 },
		]);
		assert.deepEqual(batch, [
			{ path: 'ch.0.mix.lvl', value: 0.1, sent: true },
			{ path: 'ch.99.mix.lvl', value: 5, sent: false },
			{ path: 'bus.0.mix.lvl', value: -6, sent: true },
		]);
		assert.equal(state.values.get('ch.0.mix.lvl'), 0.1);
		assert.equal(state.values.get('bus.0.mix.lvl'), -6);
	});
});

test('gateway scene management lists, reads, and recalls scenes', async (t) => {
	await withClient(t, MOCK_MIXER, async (state, client) => {
		const parameters = await new ParameterDiscovery(client).discover();
		const gateway = new MsMcpGateway(client, parameters);

		assert.deepEqual(await gateway.listScenes(), [
			{ index: 0, name: 'Scene 1' },
			{ index: 1, name: 'Scene 2' },
			{ index: 2, name: 'Sound Check' },
		]);
		assert.deepEqual(await gateway.getCurrentScene(), { index: 0 });
		assert.deepEqual(await gateway.recallScene(2), { index: 2, recalled: true });
		assert.equal(state.values.get('scene.current'), 2);
		assert.deepEqual(await gateway.getCurrentScene(), { index: 2 });
	});
});

test('MCP server exposes fixed and generated tools, resources, and validation', async (t) => {
	await withClient(t, MOCK_MIXER, async (state, client) => {
		const parameters = await new ParameterDiscovery(client).discover();
		const gateway = new MsMcpGateway(client, parameters);
		const server = createMsMcpServer(gateway);
		const [clientTransport, serverTransport] = ClientTransport.createLinkedPair();
		const mcpClient = new Client({ name: 'msmcp-test', version: '1' });
		await Promise.all([
			mcpClient.connect(clientTransport),
			server.server.connect(serverTransport as unknown as ServerTransport),
		]);
		t.after(async () => {
			await mcpClient.close();
			await server.close();
		});

		const tools = await mcpClient.listTools();
		const names = tools.tools.map((tool) => tool.name);
		for (const fixed of ['mixer.list_parameters', 'mixer.get', 'mixer.set', 'mixer.batch', 'mixer.subscribe', 'mixer.unsubscribe', 'mixer.scene.list', 'mixer.scene.get_current', 'mixer.scene.recall']) {
			assert.ok(names.includes(fixed), `missing fixed tool ${fixed}`);
		}
		assert.ok(names.includes('mixer.ch.0.mix.lvl.get'));
		assert.ok(names.includes('mixer.ch.0.mix.lvl.set'));
		assert.ok(names.includes('mixer.ch.0.mix.mute.set'));
		assert.ok(!names.includes('mixer.ch.2.mix.lvl.get'), 'undiscovered path must not generate a tool');

		const setTool = tools.tools.find((tool) => tool.name === 'mixer.ch.0.mix.mute.set')!;
		const schema = setTool.inputSchema as { properties?: Record<string, unknown> };
		assert.equal((schema.properties?.value as { type: string }).type, 'boolean');

		const getCall = await mcpClient.callTool({ name: 'mixer.ch.0.mix.lvl.get', arguments: {} });
		assert.equal(getCall.isError, undefined);
		assert.ok(JSON.stringify(getCall.content).includes('-5'));

		const setCall = await mcpClient.callTool({ name: 'mixer.set', arguments: { path: 'ch.1.mix.lvl', value: 0.5 } });
		assert.equal(setCall.isError, undefined);
		assert.equal(state.values.get('ch.1.mix.lvl'), 0.5);

		const listCall = await mcpClient.callTool({ name: 'mixer.list_parameters', arguments: {} });
		assert.equal(listCall.isError, undefined);
		assert.ok(JSON.stringify(listCall.content).includes('Channel 1 Fader'));

		const batchCall = await mcpClient.callTool({
			name: 'mixer.batch',
			arguments: { calls: [{ path: 'ch.0.mix.lvl', value: 0.2 }, { path: 'ch.1.mix.lvl', value: 0.3 }] },
		});
		assert.equal(batchCall.isError, undefined);
		const batchText = batchCall.content[0];
		assert.ok(batchText && 'text' in batchText && batchText.text.includes('"sent":true'));

		// The server validates every path before sending: one unknown path
		// rejects the whole batch, so a typo never half-applies.
		const badBatch = await mcpClient.callTool({
			name: 'mixer.batch',
			arguments: { calls: [{ path: 'ch.0.mix.lvl', value: 0.2 }, { path: 'ch.99.mix.lvl', value: 5 }] },
		});
		assert.equal(badBatch.isError, true);
		assert.ok(JSON.stringify(badBatch.content).includes('unknown parameter path'));

		const unknownCall = await mcpClient.callTool({ name: 'mixer.get', arguments: { path: 'ch.99.mix.lvl' } });
		assert.equal(unknownCall.isError, true);
		assert.ok(JSON.stringify(unknownCall.content).includes('unknown parameter path'));

		const wrongTypeCall = await mcpClient.callTool({ name: 'mixer.ch.0.mix.mute.set', arguments: { value: 'loud' } });
		assert.equal(wrongTypeCall.isError, true);

		const subscribeCall = await mcpClient.callTool({ name: 'mixer.subscribe', arguments: { path: 'ch.*.mix.lvl' } });
		assert.equal(subscribeCall.isError, undefined);
		const unsubscribeCall = await mcpClient.callTool({ name: 'mixer.unsubscribe', arguments: { path: 'ch.*.mix.lvl' } });
		assert.equal(unsubscribeCall.isError, undefined);
		const sceneListCall = await mcpClient.callTool({ name: 'mixer.scene.list', arguments: {} });
		assert.equal(sceneListCall.isError, undefined);
		assert.ok(JSON.stringify(sceneListCall.content).includes('Sound Check'));

		const sceneCurrentCall = await mcpClient.callTool({ name: 'mixer.scene.get_current', arguments: {} });
		assert.equal(sceneCurrentCall.isError, undefined);

		const sceneRecallCall = await mcpClient.callTool({ name: 'mixer.scene.recall', arguments: { index: 2 } });
		assert.equal(sceneRecallCall.isError, undefined);
		assert.equal(state.values.get('scene.current'), 2);

		const badRecallCall = await mcpClient.callTool({ name: 'mixer.scene.recall', arguments: { index: -1 } });
		assert.equal(badRecallCall.isError, true);

		const parametersResource = await mcpClient.readResource({ uri: 'mixer://parameters' });
		assert.equal(parametersResource.contents.length, 1);
		const parameterContent = parametersResource.contents[0];
		assert.ok(parameterContent && 'text' in parameterContent);
		assert.ok(parameterContent.text.includes('ch.0.mix.lvl'));

		const statusResource = await mcpClient.readResource({ uri: 'mixer://status' });
		const statusContent = statusResource.contents[0];
		assert.ok(statusContent && 'text' in statusContent);
		const status = JSON.parse(statusContent.text) as unknown;
		assert.ok(typeof status === 'object' && status !== null && 'connected' in status);
		assert.equal(status.connected, true);
	});
});
