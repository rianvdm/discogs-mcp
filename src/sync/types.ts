// ABOUTME: Type contracts for the collection sync subsystem.
// ABOUTME: SnapshotBlob, ProgressBlob, SyncResult, SyncOptions.

import type { DiscogsCollectionItem } from '../clients/discogs'

export interface SnapshotBlob {
	schemaVersion: 1
	fetchedAt: string
	count: number
	topPageInstanceIds: number[]
	items: DiscogsCollectionItem[]
}

export interface ProgressBlob {
	schemaVersion: 1
	startedAt: string
	totalPages: number
	totalCount: number
	lastPageFetched: number
	itemsSoFar: DiscogsCollectionItem[]
}

export interface TokenMirror {
	numericId: string
	username: string
	accessToken: string
	accessTokenSecret: string
}

export type SyncOutcome =
	| 'completed'
	| 'resumed'
	| 'skipped'
	| 'failed'
	| 'crashed'
	| 'no_token'
	| 'token_invalid'
	| 'in_progress'

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
