import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import { MixingStationClient } from '../src/mixingstation.js';

interface MockState {
	http: HttpServer;
	wss: WebSocketServer;
	values: Map<string, unknown>;
	connections: WebSocket[];
	port: number;
}

/** In-process stand-in for Mixing Station Desktop's websocket/REST API. */
function startMock(): Promise<MockState> {
	return new Promise((resolve) => {
		const values = new Map<string, unknown>([['ch.0.mix.lvl', -5]]);
		const connections: WebSocket[] = [];
		const http = createServer((req, res) => {
			const match = /^\/console\/data\/(.+)$/.exec(req.url ?? '');
			if (match && req.method === 'GET') {
				const dataPath = decodeURIComponent(match[1]!);
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ path: req.url, method: 'GET', body: values.get(dataPath) ?? null, error: null }));
				return;
			}
			res.statusCode = 404;
			res.end('{}');
		});
		const wss = new WebSocketServer({ server: http });
		wss.on('connection', (socket) => {
			connections.push(socket);
			socket.on('message', (data) => {
				const request = JSON.parse(data.toString()) as { path: string; method: string; body?: unknown };
				const dataPath = request.path.replace(/^\/console\/data\//, '');
				const reply = (body: unknown, error: string | null = null) => {
					socket.send(JSON.stringify({ path: request.path, method: request.method, body, error }));
				};
				if (request.path === '/console/data/ch.9.error') {
					reply(null, 'boom');
					return;
				}
				if (request.path === '/console/data/ch.9.timeout') {
					return; // never reply
				}
				if (request.method === 'GET') {
					reply(values.get(dataPath) ?? null);
					return;
				}
				if (dataPath === 'subscribe') {
					let pattern = 'unknown';
					if (request.body !== null && typeof request.body === 'object' && 'path' in request.body) {
						pattern = String(request.body.path);
					}
					if (pattern === 'ch.9.error') {
						reply(null, 'boom');
						return;
					}
					reply(null);
					const concrete = pattern.replace('*', '0');
					socket.send(JSON.stringify({ path: `/console/data/${concrete}`, method: 'POST', body: values.get(concrete) ?? 0, error: null }));
					return;
				}
				if (dataPath === 'unsubscribe') {
					reply(null);
					return;
				}
				values.set(dataPath, request.body);
				reply(request.body);
			});
		});
		http.listen(0, '127.0.0.1', () => {
			resolve({ http, wss, values, connections, port: (http.address() as { port: number }).port });
		});
	});
}

function push(state: MockState, path: string, value: unknown): void {
	for (const socket of state.connections) {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ path: `/console/data/${path}`, method: 'POST', body: value, error: null }));
		}
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function withMock(t: { after: (fn: () => void | Promise<void>) => void }, timeoutMs = 300, run: (state: MockState, client: MixingStationClient) => Promise<void>): Promise<void> {
	const state = await startMock();
	const client = new MixingStationClient({ host: '127.0.0.1', port: state.port, timeoutMs, reconnectDelayMs: 30, maxReconnectDelayMs: 60 });
	t.after(() => {
		client.close();
		for (const socket of state.connections) socket.terminate();
		state.wss.close();
		state.http.close();
	});
	await run(state, client);
}

test('get reads a value over the websocket', async (t) => {
	await withMock(t, 300, async (state, client) => {
		await client.connect();
		assert.equal(await client.get('ch.0.mix.lvl'), -5);
	});
});

test('set writes a value and reads it back', async (t) => {
	await withMock(t, 300, async (state, client) => {
		await client.connect();
		assert.equal(await client.set('ch.1.mix.lvl', 0.5), 0.5);
		assert.equal(state.values.get('ch.1.mix.lvl'), 0.5);
		assert.equal(await client.get('ch.1.mix.lvl'), 0.5);
	});
});

test('subscribe delivers the initial value and pushed updates', async (t) => {
	await withMock(t, 300, async (state, client) => {
		await client.connect();
		const received: unknown[] = [];
		await client.subscribe('ch.*.mix.lvl', (value) => received.push(value));
		await waitFor(() => received.length >= 1);
		assert.deepEqual(received, [-5]);
		push(state, 'ch.2.mix.lvl', 0.25);
		await waitFor(() => received.length >= 2);
		assert.deepEqual(received, [-5, 0.25]);
	});
});

test('subscribe rejects when the server reports an error', async (t) => {
	await withMock(t, 300, async (state, client) => {
		await client.connect();
		await assert.rejects(client.subscribe('ch.9.error', () => {}), /boom/);
	});
});

test('error responses reject the request', async (t) => {
	await withMock(t, 300, async (state, client) => {
		await client.connect();
		await assert.rejects(client.get('ch.9.error'), /boom/);
	});
});

test('unanswered requests time out', async (t) => {
	await withMock(t, 100, async (state, client) => {
		await client.connect();
		await assert.rejects(client.get('ch.9.timeout'), /timed out/);
	});
});

test('get/set throw when not connected', async (t) => {
	const state = await startMock();
	const client = new MixingStationClient({ host: '127.0.0.1', port: state.port, timeoutMs: 100 });
	t.after(() => {
		client.close();
		state.wss.close();
		state.http.close();
	});
	await assert.rejects(client.get('ch.0.mix.lvl'), /not connected/);
	await assert.rejects(client.set('ch.0.mix.lvl', 1), /not connected/);
});

test('reconnects and resubscribes after a disconnect', async (t) => {
	await withMock(t, 300, async (state, client) => {
		await client.connect();
		const received: unknown[] = [];
		await client.subscribe('ch.*.mix.lvl', (value) => received.push(value));
		await waitFor(() => received.length >= 1);

		for (const socket of state.connections) socket.terminate();
		await waitFor(() => state.connections.length >= 2 && client.connected);
		push(state, 'ch.3.mix.lvl', -3);
		await waitFor(() => received.some((value) => value === -3), 3000);
	});
});

test('restGet reads over plain HTTP', async (t) => {
	await withMock(t, 300, async (state, client) => {
		const body = await client.restGet('ch.0.mix.lvl');
		assert.deepEqual(body, { path: '/console/data/ch.0.mix.lvl', method: 'GET', body: -5, error: null });
	});
});
