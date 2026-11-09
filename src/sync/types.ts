// ABOUTME: Type contracts for the collection sync subsystem.
// ABOUTME: SnapshotBlob, ProgressBlob, SyncResult, LastSyncRecord, SyncOptions.

import type { DiscogsCollectionItem } from '../clients/discogs'

/**
 * The subset of a collection item that search, stats and recommendations
 * read. Image and API URLs are dropped: they roughly triple the stored size
 * and nothing reads them from the snapshot. Structurally assignable to
 * DiscogsCollectionItem, so readers work on either.
 */
export interface SnapshotItem {
	id: number
	instance_id: number
	folder_id?: number
	date_added: string
	rating: number
	basic_information: {
		id: number
		master_id?: number
		title: string
		year: number
		formats: Array<{ name: string; qty: string; descriptions?: string[] }>
		labels: Array<{ name: string; catno: string }>
		artists: Array<{ name: string }>
		genres: string[]
		styles: string[]
	}
}

export function toSnapshotItem(item: DiscogsCollectionItem): SnapshotItem {
	const b = item.basic_information
	return {
		id: item.id,
		instance_id: item.instance_id,
		folder_id: item.folder_id,
		date_added: item.date_added,
		rating: item.rating,
		basic_information: {
			id: b.id,
			master_id: b.master_id,
			title: b.title,
			year: b.year,
			formats: (b.formats ?? []).map((f) => ({ name: f.name, qty: f.qty, descriptions: f.descriptions })),
			labels: (b.labels ?? []).map((l) => ({ name: l.name, catno: l.catno })),
			artists: (b.artists ?? []).map((a) => ({ name: a.name })),
			genres: b.genres ?? [],
			styles: b.styles ?? [],
		},
	}
}

export interface SnapshotBlob {
	schemaVersion: 1
	fetchedAt: string
	count: number
	topPageInstanceIds: number[]
	items: SnapshotItem[]
}

/**
 * Bookkeeping for an in-flight sync. Deliberately carries no items: pages
 * 1..lastPageFetched live under their own keys (see pageKey) so the cost of
 * persisting progress is one page, not the whole collection so far. Records
 * with any other schemaVersion are ignored and the sync starts over.
 */
export interface ProgressBlob {
	schemaVersion: 2
	startedAt: string
	totalPages: number
	totalCount: number
	lastPageFetched: number
}

export interface TokenMirror {
	numericId: string
	username: string
	accessToken: string
	accessTokenSecret: string
}

export type SyncOutcome = 'completed' | 'resumed' | 'skipped' | 'failed' | 'crashed' | 'no_token' | 'token_invalid' | 'in_progress'

export interface SyncResult {
	outcome: SyncOutcome
	/** Discogs page fetches that succeeded in this invocation, probe and restarts included. */
	pagesFetched: number
	count?: number
	fetchedAt?: string
	error?: string
	/** Last page stored for the current sweep. Set on failed and resumed results once a page is stored. */
	syncedThroughPage?: number
	/** Page count of the current sweep, set alongside syncedThroughPage. */
	totalPages?: number
}

/** What started a sync run: the cron, or a user calling refresh_collection. */
export type SyncTrigger = 'scheduled' | 'manual'

/**
 * The outcome of a user's most recent sync run, kept so get_cache_stats can show
 * a failing background sync that would otherwise only appear in the Worker logs.
 * Records with any other schemaVersion are ignored.
 */
export interface LastSyncRecord {
	schemaVersion: 1
	outcome: SyncOutcome
	trigger: SyncTrigger
	/** ISO time the run finished. */
	at: string
	pagesFetched: number
	count?: number
	/** Whitespace collapsed, truncated to 500 characters. */
	error?: string
	/** Runs in a row whose outcome was failed, crashed, or token_invalid, including this one. 0 when this run was healthy. */
	consecutiveFailures: number
	/** ISO time of the most recent completed, resumed, or skipped run; null if none recorded yet. */
	lastHealthyAt: string | null
}

export interface SyncOptions {
	force?: boolean
	now?: () => Date
	sleep?: (ms: number) => Promise<void>
}
