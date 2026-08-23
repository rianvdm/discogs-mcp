// ABOUTME: Type contracts for the collection sync subsystem.
// ABOUTME: SnapshotBlob, ProgressBlob, SyncResult, SyncOptions.

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
	pagesFetched: number
	count?: number
	fetchedAt?: string
	error?: string
}

export interface SyncOptions {
	force?: boolean
	now?: () => Date
	sleep?: (ms: number) => Promise<void>
}
