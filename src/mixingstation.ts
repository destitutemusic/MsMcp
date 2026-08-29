import WebSocket from 'ws';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 1234;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_RECONNECT_DELAY_MS = 1_000;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;

export type ValueFormat = 'val' | 'norm';

/**
 * A reply from Mixing Station's websocket API. The server echoes the request's
 * `path` and `method`; `body` carries the payload (for a data GET/POST this is
 * the plain value, e.g. -5 for a fader in dB) and `error` is null on success.
 */
export interface MixingStationResponse {
	path: string;
	method: string;
	body: unknown;
	error: string | null;
}

/** Request envelope: `{ "path": "/console/data/ch.0.mix.lvl", "method": "GET", "body": null }`. */
export interface MixingStationRequest {
	path: string;
	method: 'GET' | 'POST';
	body?: unknown;
}

/** A subscription to a parameter path pattern (`ch.*.mix.lvl`), in plain or normalized format. */
export interface MixingStationSubscription {
	path: string;
	format: ValueFormat;
	handler: (value: unknown, message: MixingStationResponse) => void;
}

export type SubscriptionHandler = MixingStationSubscription['handler'];

export interface MixingStationClientOptions {
	/** Mixing Station Desktop host; default 127.0.0.1. */
	host?: string;
	/** REST/websocket port; default 1234. */
	port?: number;
	/** Timeout for a request or subscription handshake; default 5000ms. */
	timeoutMs?: number;
	/** Initial delay before the first reconnect attempt; default 1000ms. */
	reconnectDelayMs?: number;
	/** Reconnect backoff cap; default 10000ms. */
	maxReconnectDelayMs?: number;
	/** Called after a successful automatic reconnect (subscriptions restored). */
	onReconnect?: () => void;
	/** Called when the websocket drops (also passes the socket error if any). */
	onDisconnect?: (error?: Error) => void;
}

interface PendingRequest {
	resolve: (response: MixingStationResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Strip a leading '/', 'console/data/' prefix and whitespace from a parameter path. */
function normalizePattern(pattern: string): string {
	let path = pattern.trim();
	while (path.startsWith('/')) path = path.slice(1);
	if (path.startsWith('console/data/')) path = path.slice('console/data/'.length);
	return path;
}

function normalizeDataPath(dataPath: string): string {
	let path = dataPath.trim();
	while (path.startsWith('/')) path = path.slice(1);
	return path;
}

/** Full websocket request path for a data endpoint, e.g. `/console/data/ch.0.mix.lvl`. */
function dataEndpoint(dataPath: string): string {
	return `/console/data/${normalizeDataPath(dataPath)}`;
}

/** Compile a Mixing Station path pattern (`ch.*.mix.lvl`) to a regex over bare data paths. */
function wildcardToRegex(pattern: string): RegExp {
	let source = '^';
	for (const character of pattern) {
		if (character === '*') source += '.*';
		else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	source += '$';
	return new RegExp(source);
}

/**
 * Client for Mixing Station Desktop's REST/websocket API.
 *
 * Wire protocol (https://mixingstation.app/ms-docs/use-cases/apis/):
 *   request:  { "path": "/console/data/ch.0.mix.lvl", "method": "GET"|"POST", "body": <value> }
 *   response: { "path": "/console/data/ch.0.mix.lvl", "method": "GET", "body": <value>, "error": null }
 *   subscribe: POST /console/data/subscribe with body { "path": "ch.*.mix.lvl", "format": "val" }
 *
 * The protocol has no request ids — responses echo `method` + `path`, so pending
 * requests are correlated by `${method} ${path}` (FIFO per key; concurrent
 * requests to the same path resolve in send order). Subscription updates arrive
 * on `/console/data/<concrete-path>` and are dispatched to every subscribed
 * pattern that matches.
 *
 * The websocket reconnects automatically with capped exponential backoff after
 * a successful connection drops; active subscriptions are re-established on
 * reconnect. A failed initial connect() rejects and does not retry in the
 * background — call connect() again when Mixing Station is reachable.
 */
export class MixingStationClient {
	private readonly host: string;
	private readonly port: number;
	private readonly timeoutMs: number;
	private readonly reconnectDelayMs: number;
	private readonly maxReconnectDelayMs: number;
	private readonly onReconnect: (() => void) | undefined;
	private readonly onDisconnect: ((error?: Error) => void) | undefined;

	private socket: WebSocket | undefined;
	private connecting: Promise<void> | undefined;
	private rejectConnecting: ((error: Error) => void) | undefined;
	private lastError: Error | undefined;
	private closed = false;
	private hasConnectedOnce = false;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	/** Pending requests keyed by `${method} ${path}`, FIFO per key. */
	private readonly pending = new Map<string, PendingRequest[]>();
	private readonly subscriptions = new Map<string, MixingStationSubscription>();
	/** Resolvers waiting for the first update of a subscription handshake. */
	private readonly firstUpdates = new Map<string, Array<() => void>>();

	constructor(options: MixingStationClientOptions = {}) {
		this.host = options.host ?? DEFAULT_HOST;
		this.port = options.port ?? DEFAULT_PORT;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
		this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
		this.onReconnect = options.onReconnect;
		this.onDisconnect = options.onDisconnect;
	}

	get url(): string {
		return `ws://${this.host}:${this.port}`;
	}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	/** Open the websocket. Resolves when the connection is established; rejects on failure. */
	connect(): Promise<void> {
		return this.openSocket();
	}

	/** Read a parameter value over the websocket. Resolves with the response `body`. */
	async get(dataPath: string): Promise<unknown> {
		const response = await this.sendRequest({ method: 'GET', path: dataEndpoint(dataPath) });
		return response.body;
	}

	/** Write a parameter value over the websocket. Resolves with the response `body`. */
	async set(dataPath: string, value: unknown): Promise<unknown> {
		const response = await this.sendRequest({ method: 'POST', path: dataEndpoint(dataPath), body: value });
		return response.body;
	}

	/**
	 * Subscribe to a parameter path pattern. Resolves once the subscription is
	 * active (server ack or the initial value update), rejects on error or timeout.
	 * A re-subscribe to the same pattern replaces the handler.
	 */
	subscribe(path: string, handler: SubscriptionHandler, format: ValueFormat = 'val'): Promise<void> {
		const pattern = normalizePattern(path);
		this.subscriptions.set(pattern, { path: pattern, format, handler });
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(
				() => settle(new Error(`Mixing Station subscribe '${pattern}' timed out after ${this.timeoutMs}ms`)),
				this.timeoutMs,
			);
			const cleanup = () => {
				const resolvers = this.firstUpdates.get(pattern);
				if (resolvers) {
					const index = resolvers.indexOf(settleFirst);
					if (index !== -1) resolvers.splice(index, 1);
					if (resolvers.length === 0) this.firstUpdates.delete(pattern);
				}
				clearTimeout(timer);
			};
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const settleFirst = () => settle();
			let resolvers = this.firstUpdates.get(pattern);
			if (!resolvers) {
				resolvers = [];
				this.firstUpdates.set(pattern, resolvers);
			}
			resolvers.push(settleFirst);
			this.sendRequest({ method: 'POST', path: '/console/data/subscribe', body: { path: pattern, format } })
				.then(() => settle(), (error) => settle(error instanceof Error ? error : new Error(String(error))));
		});
	}

	/**
	 * Stop dispatching updates for a pattern. Local dispatch stops immediately;
	 * removal on the server is best-effort (the unsubscribe endpoint is not
	 * documented, so no error is raised if Mixing Station ignores it).
	 */
	unsubscribe(path: string): void {
		const pattern = normalizePattern(path);
		this.subscriptions.delete(pattern);
		const socket = this.socket;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ method: 'POST', path: '/console/data/unsubscribe', body: { path: pattern } }));
		}
	}

	/**
	 * Read a parameter over plain HTTP REST (same `/console/data/<path>` endpoints,
	 * mirrored by Mixing Station). The HTTP response envelope is not documented by
	 * Mixing Station, so the parsed JSON body is returned as-is.
	 */
	async restGet(dataPath: string): Promise<unknown> {
		return this.httpRequest('GET', dataPath);
	}

	/** Write a parameter over plain HTTP REST; see {@link restGet} for envelope caveats. */
	async restSet(dataPath: string, value: unknown): Promise<unknown> {
		return this.httpRequest('POST', dataPath, value);
	}

	/** Stop the client: close the socket, cancel reconnects, reject pending requests. */
	close(): void {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.failPending(new Error('Mixing Station client closed'));
		this.rejectConnecting?.(new Error('Mixing Station client closed'));
		this.rejectConnecting = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
			else socket.close();
		}
	}

	private openSocket(): Promise<void> {
		if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
		if (this.connecting) return this.connecting;
		this.connecting = new Promise<void>((resolve, reject) => {
			const socket = new WebSocket(`ws://${this.host}:${this.port}`);
			this.socket = socket;
			this.rejectConnecting = reject;
			socket.on('open', () => {
				this.rejectConnecting = undefined;
				this.hasConnectedOnce = true;
				resolve();
			});
			socket.on('message', (data) => this.handleMessage(data));
			socket.on('error', (error) => {
				this.lastError = error instanceof Error ? error : new Error(String(error));
			});
			socket.on('close', () => this.handleClose());
		}).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private handleClose(): void {
		this.socket = undefined;
		this.rejectConnecting?.(new Error('Mixing Station connection closed'));
		this.rejectConnecting = undefined;
		this.failPending(new Error('Mixing Station connection lost'));
		const error = this.lastError;
		this.lastError = undefined;
		this.onDisconnect?.(error);
		if (this.closed) return;
		// Only auto-reconnect after a connection that already succeeded once;
		// a failed initial connect() leaves retrying to the caller.
		if (!this.hasConnectedOnce) return;
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.closed) return;
		const attempt = this.reconnectAttempts;
		this.reconnectAttempts += 1;
		const delay = Math.min(this.reconnectDelayMs * 2 ** attempt, this.maxReconnectDelayMs);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.openSocket()
				.then(() => {
					this.reconnectAttempts = 0;
					this.resubscribe();
					this.onReconnect?.();
				})
				.catch(() => {
					// The socket 'close' handler schedules the next attempt.
				});
		}, delay);
	}

	private resubscribe(): void {
		for (const subscription of this.subscriptions.values()) {
			this.sendRequest({ method: 'POST', path: '/console/data/subscribe', body: { path: subscription.path, format: subscription.format } })
				.catch(() => {
					// A failed resubscribe is retried on the next reconnect.
				});
		}
	}

	private handleMessage(data: WebSocket.RawData): void {
		let message: unknown;
		try {
			message = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
		const record = message as Record<string, unknown>;
		const { path, method, body, error } = record;
		if (typeof path !== 'string' || typeof method !== 'string') return;
		const response: MixingStationResponse = { path, method, body, error: error == null ? null : String(error) };

		const key = `${method} ${path}`;
		const queue = this.pending.get(key);
		if (queue && queue.length > 0) {
			const pending = queue.shift()!;
			if (queue.length === 0) this.pending.delete(key);
			clearTimeout(pending.timer);
			if (response.error !== null) {
				pending.reject(new Error(`Mixing Station request '${key}' failed: ${response.error}`));
			} else {
				pending.resolve(response);
			}
			return;
		}
		if (path === '/console/data/subscribe' || path === '/console/data/unsubscribe') return;
		if (!path.startsWith('/console/data/')) return;

		const dataPath = path.slice('/console/data/'.length);
		for (const subscription of this.subscriptions.values()) {
			if (!wildcardToRegex(subscription.path).test(dataPath)) continue;
			const resolvers = this.firstUpdates.get(subscription.path);
			if (resolvers && resolvers.length > 0) {
				const settleFirst = resolvers.shift()!;
				if (resolvers.length === 0) this.firstUpdates.delete(subscription.path);
				settleFirst();
			}
			try {
				subscription.handler(response.body, response);
			} catch {
				// A handler error must not break the message loop.
			}
		}
	}

	private sendRequest(request: MixingStationRequest): Promise<MixingStationResponse> {
		const socket = this.requireSocket();
		const key = `${request.method} ${request.path}`;
		return new Promise<MixingStationResponse>((resolve, reject) => {
			const pending: PendingRequest = {
				resolve,
				reject,
				timer: setTimeout(() => {
					const queue = this.pending.get(key);
					if (queue) {
						const index = queue.indexOf(pending);
						if (index !== -1) queue.splice(index, 1);
						if (queue.length === 0) this.pending.delete(key);
					}
					reject(new Error(`Mixing Station request '${key}' timed out after ${this.timeoutMs}ms`));
				}, this.timeoutMs),
			};
			let queue = this.pending.get(key);
			if (!queue) {
				queue = [];
				this.pending.set(key, queue);
			}
			queue.push(pending);
			socket.send(JSON.stringify(request));
		});
	}

	private requireSocket(): WebSocket {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new Error('Mixing Station client is not connected — call connect() first');
		}
		return socket;
	}

	private failPending(error: Error): void {
		for (const queue of this.pending.values()) {
			for (const pending of queue) {
				clearTimeout(pending.timer);
				pending.reject(error);
			}
		}
		this.pending.clear();
	}

	private async httpRequest(method: 'GET' | 'POST', dataPath: string, value?: unknown): Promise<unknown> {
		const path = dataEndpoint(dataPath);
		const response = await fetch(`http://${this.host}:${this.port}${path}`, {
			method,
			headers: value === undefined ? undefined : { 'content-type': 'application/json' },
			body: value === undefined ? undefined : JSON.stringify(value),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) {
			throw new Error(`Mixing Station REST ${method} ${path} failed: HTTP ${response.status}`);
		}
		return response.json();
	}
}
