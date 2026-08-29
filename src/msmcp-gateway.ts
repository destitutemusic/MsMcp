import type { DiscoveredParameter } from './discovery.js';
import type { MixingStationClient } from './mixingstation.js';

export interface ParameterRead {
	path: string;
	value: unknown;
}

export interface ParameterWrite {
	path: string;
	value: unknown;
	sent: boolean;
}

export interface SceneInfo {
	index: number;
	name: string;
}

export interface SceneRecall {
	index: number;
	recalled: true;
}
export interface BatchCall {
	path: string;
	value: unknown;
}

/**
 * Command adapter between MCP tools and Mixing Station. A thin, typed wrapper
 * around MixingStationClient that also carries the discovered parameter
 * catalog so tools can validate paths up front.
 */
export class MsMcpGateway {
	constructor(
		private readonly client: MixingStationClient,
		private readonly parameters: DiscoveredParameter[],
	) {}

	getParameters(): DiscoveredParameter[] {
		return this.parameters;
	}

	getParameter(path: string): DiscoveredParameter | undefined {
		return this.parameters.find((parameter) => parameter.path === path);
	}

	get connected(): boolean {
		return this.client.connected;
	}

	get url(): string {
		return this.client.url;
	}

	async get(path: string): Promise<ParameterRead> {
		const value = await this.client.get(path);
		return { path, value };
	}

	async set(path: string, value: unknown): Promise<ParameterWrite> {
		await this.client.set(path, value);
		return { path, value, sent: true };
	}

	subscribe(path: string, handler: (value: unknown) => void): Promise<void> {
		return this.client.subscribe(path, handler);
	}

	unsubscribe(path: string): void {
		this.client.unsubscribe(path);
	}

	/** Sets values sequentially; a failed call is reported as `sent: false`, not fatal. */
	async batch(calls: BatchCall[]): Promise<ParameterWrite[]> {
		const results: ParameterWrite[] = [];
		for (const call of calls) {
			try {
				await this.client.set(call.path, call.value);
				results.push({ path: call.path, value: call.value, sent: true });
			} catch {
				results.push({ path: call.path, value: call.value, sent: false });
			}
		}
		return results;
	}
	/** Lists Mixing Station scenes; the scene index is the position in the returned array. */
	async listScenes(): Promise<SceneInfo[]> {
		const body = await this.client.get('scene.list');
		const names = Array.isArray(body) ? body : [];
		return names.map((name, index) => ({ index, name: String(name) }));
	}

	/** Reads the currently active scene index. */
	async getCurrentScene(): Promise<{ index: number }> {
		const index = await this.client.get('scene.current');
		if (typeof index !== 'number' || !Number.isInteger(index)) {
			throw new Error(`Mixing Station scene.current returned an invalid index: ${String(index)}`);
		}
		return { index };
	}

	/** Recalls a scene by index; the mixer applies the change asynchronously. */
	async recallScene(index: number): Promise<SceneRecall> {
		await this.client.set('scene.recall', { index });
		return { index, recalled: true };
	}

	async close(): Promise<void> {
		this.client.close();
	}
}
