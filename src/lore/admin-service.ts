/**
 * LoreAdminService — file-backed CRUD for the lore canon.
 *
 * Reads from a reloadable snapshot, writes via atomic JSON writer,
 * and triggers reload after every mutation so the live LoreService
 * picks up the change on the next prompt-assembly request.
 */

import { readJsonFile, writeJsonFileAtomic } from "../config/atomic-writer.js";
import { createReloadable, type ReloadableSnapshot } from "../config/reloadable.js";
import { MaidsClawError } from "../core/errors.js";
import type { LoreEntry, LoreScope } from "./entry-schema.js";
import { validateLoreEntry } from "./entry-schema.js";

// ── Public types ─────────────────────────────────────────────────────────────

export type LoreAdminServiceOptions = {
	/** Absolute path to config/lore.json. */
	configPath: string;
};

export type LoreListFilters = {
	scope?: LoreScope;
	keyword?: string;
};

export type LoreAdminService = {
	listLore(filters?: LoreListFilters): Promise<LoreEntryDto[]>;
	getLore(id: string): Promise<LoreEntryDto | null>;
	createLore(data: unknown): Promise<LoreEntryDto>;
	updateLore(id: string, data: unknown): Promise<LoreEntryDto>;
	deleteLore(id: string): Promise<void>;
};

// ── Wire DTO (snake_case) ────────────────────────────────────────────────────

export type LoreEntryDto = {
	id: string;
	title: string;
	keywords: string[];
	content: string;
	scope: LoreScope;
	priority: number;
	enabled: boolean;
	tags: string[];
};

function toDto(entry: LoreEntry): LoreEntryDto {
	return {
		id: entry.id,
		title: entry.title,
		keywords: entry.keywords,
		content: entry.content,
		scope: entry.scope,
		priority: entry.priority ?? 0,
		enabled: entry.enabled,
		tags: entry.tags ?? [],
	};
}

// ── Snapshot loader ──────────────────────────────────────────────────────────

async function loadEntries(configPath: string): Promise<readonly LoreEntry[]> {
	let raw: unknown;
	try {
		raw = await readJsonFile<unknown>(configPath);
	} catch {
		// File missing → empty canon
		return [];
	}

	const items = Array.isArray(raw) ? raw : [raw];
	const entries: LoreEntry[] = [];
	for (const item of items) {
		const result = validateLoreEntry(item);
		if (result.ok) {
			entries.push(result.entry);
		}
	}
	return entries;
}

// ── Sorting ──────────────────────────────────────────────────────────────────

function sortEntries(entries: LoreEntryDto[]): LoreEntryDto[] {
	return entries.sort((a, b) => {
		const pDiff = b.priority - a.priority;
		if (pDiff !== 0) return pDiff;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createLoreAdminService(
	options: LoreAdminServiceOptions,
): LoreAdminService {
	const { configPath } = options;

	let snapshot: ReloadableSnapshot<readonly LoreEntry[]> = createReloadable({
		initial: [] as readonly LoreEntry[],
		load: () => loadEntries(configPath),
	});

	let initialLoadDone = false;

	async function ensureLoaded(): Promise<readonly LoreEntry[]> {
		if (!initialLoadDone) {
			await snapshot.reload();
			initialLoadDone = true;
		}
		return snapshot.get();
	}

	async function persist(entries: LoreEntry[]): Promise<void> {
		await writeJsonFileAtomic(configPath, entries);
		snapshot = createReloadable({
			initial: entries as readonly LoreEntry[],
			load: () => loadEntries(configPath),
		});
		initialLoadDone = true;
	}

	return {
		async listLore(filters?: LoreListFilters): Promise<LoreEntryDto[]> {
			const entries = await ensureLoaded();
			let result = entries.map(toDto);

			if (filters?.scope) {
				result = result.filter((e) => e.scope === filters.scope);
			}

			if (filters?.keyword) {
				const needle = filters.keyword.toLowerCase();
				result = result.filter(
					(e) =>
						e.keywords.some((k) => k.toLowerCase().includes(needle)) ||
						e.title.toLowerCase().includes(needle),
				);
			}

			return sortEntries(result);
		},

		async getLore(id: string): Promise<LoreEntryDto | null> {
			const entries = await ensureLoaded();
			const found = entries.find((e) => e.id === id);
			return found ? toDto(found) : null;
		},

		async createLore(data: unknown): Promise<LoreEntryDto> {
			const validated = validateLoreEntry(data);
			if (!validated.ok) {
				throw new MaidsClawError({
					code: "BAD_REQUEST",
					message: validated.reason,
					retriable: false,
				});
			}

			const entries = [...(await ensureLoaded())];
			if (entries.some((e) => e.id === validated.entry.id)) {
				throw new MaidsClawError({
					code: "CONFLICT",
					message: `Lore entry already exists: ${validated.entry.id}`,
					retriable: false,
				});
			}

			entries.push(validated.entry);
			await persist(entries);
			return toDto(validated.entry);
		},

		async updateLore(id: string, data: unknown): Promise<LoreEntryDto> {
			const validated = validateLoreEntry(data);
			if (!validated.ok) {
				throw new MaidsClawError({
					code: "BAD_REQUEST",
					message: validated.reason,
					retriable: false,
				});
			}

			if (validated.entry.id !== id) {
				throw new MaidsClawError({
					code: "BAD_REQUEST",
					message: `Body id '${validated.entry.id}' does not match path id '${id}'`,
					retriable: false,
				});
			}

			const entries = [...(await ensureLoaded())];
			const idx = entries.findIndex((e) => e.id === id);
			if (idx < 0) {
				throw new MaidsClawError({
					code: "BAD_REQUEST",
					message: `Lore entry not found: ${id}`,
					retriable: false,
				});
			}

			entries[idx] = validated.entry;
			await persist(entries);
			return toDto(validated.entry);
		},

		async deleteLore(id: string): Promise<void> {
			const entries = [...(await ensureLoaded())];
			const idx = entries.findIndex((e) => e.id === id);
			if (idx < 0) {
				throw new MaidsClawError({
					code: "BAD_REQUEST",
					message: `Lore entry not found: ${id}`,
					retriable: false,
				});
			}

			entries.splice(idx, 1);
			await persist(entries);
		},
	};
}
