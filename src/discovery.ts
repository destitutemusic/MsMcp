import type { MixingStationClient } from './mixingstation.js';

export interface DiscoveredParameter {
	/** Mixing Station data path, e.g. "ch.0.mix.lvl". */
	path: string;
	/** Value type inferred from the probe reply; 'enum' is reserved (not detectable via GET). */
	type: 'float' | 'int' | 'bool' | 'string' | 'enum';
	min?: number;
	max?: number;
	/** Human-readable label, e.g. "Channel 1 Fader". */
	label: string;
	/** Best-effort unit ("dB" for faders, "%" for pan); unknown for other keys. */
	unit?: string;
	/** Parameter family: "channels", "buses" or "dcas". */
	group: string;
	canGet: boolean;
	canSet: boolean;
}

const DEFAULT_CONCURRENCY = 10;

interface ProbeGroup {
	group: string;
	prefix: string;
	count: number;
	label: string;
}

const PROBE_GROUPS: ProbeGroup[] = [
	{ group: 'channels', prefix: 'ch', count: 32, label: 'Channel' },
	{ group: 'buses', prefix: 'bus', count: 16, label: 'Bus' },
	{ group: 'dcas', prefix: 'dca', count: 8, label: 'DCA' },
];

const PROBE_KEYS = ['mix.lvl', 'mix.mute', 'mix.pan'] as const;

function labelForKey(key: string): string {
	if (key === 'mix.lvl') return 'Fader';
	if (key === 'mix.mute') return 'Mute';
	if (key === 'mix.pan') return 'Pan';
	return key;
}

function unitForKey(key: string): string | undefined {
	if (key === 'mix.lvl') return 'dB';
	if (key === 'mix.pan') return '%';
	return undefined;
}

/**
 * Classifies a probe reply. Fader/pan paths are always floats: a fader reading
 * exactly -5 (an integer in JSON) must not pin the generated tool schema to
 * integers, or later fractional writes would be rejected. Unknown keys fall
 * back to value inspection.
 */
function typeForKeyValue(key: string, value: unknown): DiscoveredParameter['type'] {
	if (key === 'mix.mute') return 'bool';
	if (key === 'mix.lvl' || key === 'mix.pan') return 'float';
	if (typeof value === 'boolean') return 'bool';
	if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
	if (typeof value === 'string') return 'string';
	return 'float';
}

interface Probe {
	path: string;
	group: ProbeGroup;
	index: number;
	key: string;
}

/**
 * Discovers what the connected mixer actually has by GETting key parameters
 * (fader, mute, pan) on candidate channel/bus/DCA paths. Mixing Station
 * answers a GET on an unknown path with an error, so a successful reply means
 * the parameter exists. Probes run with bounded concurrency and preserve
 * probe order in the result.
 */
export class ParameterDiscovery {
	constructor(private readonly client: MixingStationClient) {}

	async discover(concurrency: number = DEFAULT_CONCURRENCY): Promise<DiscoveredParameter[]> {
		if (!this.client.connected) {
			throw new Error('Mixing Station client is not connected — call connect() before discovering parameters');
		}
		const probes: Probe[] = [];
		for (const group of PROBE_GROUPS) {
			for (let index = 0; index < group.count; index += 1) {
				for (const key of PROBE_KEYS) {
					probes.push({ path: `${group.prefix}.${index}.${key}`, group, index, key });
				}
			}
		}
		const results: Array<DiscoveredParameter | undefined> = new Array(probes.length);
		let cursor = 0;
		const workers = Array.from({ length: Math.min(concurrency, probes.length) }, async () => {
			while (cursor < probes.length) {
				const slot = cursor;
				cursor += 1;
				results[slot] = await this.probe(probes[slot]!);
			}
		});
		await Promise.all(workers);
		return results.filter((parameter): parameter is DiscoveredParameter => parameter !== undefined);
	}

	private async probe(probe: Probe): Promise<DiscoveredParameter | undefined> {
		try {
			const value = await this.client.get(probe.path);
			return {
				path: probe.path,
				type: typeForKeyValue(probe.key, value),
				label: `${probe.group.label} ${probe.index + 1} ${labelForKey(probe.key)}`,
				unit: unitForKey(probe.key),
				group: probe.group.group,
				canGet: true,
				canSet: true,
			};
		} catch {
			// An error reply means the path does not exist on this mixer.
			return undefined;
		}
	}
}
