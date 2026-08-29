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

	async close(): Promise<void> {
		this.client.close();
	}
}
