import type { DiscogsSearchResponse } from '../clients/discogs.js'

type SearchResult = DiscogsSearchResponse['results'][number]

function isOwned(
	result: SearchResult,
	ownedMasterIds: Set<number>,
	ownedReleaseIds: Set<number>,
): boolean {
	if (result.master_id && ownedMasterIds.has(result.master_id)) return true
	if (result.type === 'release' && ownedReleaseIds.has(result.id)) return true
	return false
}

function formatLine(result: SearchResult, owned: boolean): string {
	const marker = owned ? ' ✓ in your collection' : ''
	if (result.type === 'artist' || result.type === 'label') {
		return `• [ID: ${result.id}] ${result.title}${marker}`
	}
	// release or master
	const year = result.year ? ` (${result.year})` : ''
	const typeMarker = ` [${result.type}]`
	const formats = result.format?.length ? result.format.join(', ') : 'Unknown'
	const genres = result.genre?.length ? result.genre.join(', ') : 'Unknown'
	const label = result.label?.length ? ` | Label: ${result.label.slice(0, 2).join(', ')}` : ''
	return `• [ID: ${result.id}] ${result.title}${year}${typeMarker}${marker}\n  Format: ${formats} | Genre: ${genres}${label}`
}

export function formatSearchDiscogsResults(
	response: DiscogsSearchResponse,
	ownedMasterIds: Set<number>,
	ownedReleaseIds: Set<number>,
	query: string,
	type: string,
): string {
	if (response.results.length === 0) {
		return `No results found for "${query}" (type: ${type}).\n\nTry a broader query, a different type ('release', 'master', 'artist', or 'label'), or use search_collection if you're looking in your own collection.`
	}

	const lines = response.results.map((r) => formatLine(r, isOwned(r, ownedMasterIds, ownedReleaseIds)))
	const header = `Found ${response.pagination.items} results for "${query}" (showing ${response.results.length}, type: ${type}):`
	const tip = `\n**Tip:** Use the ID with the get_release tool for full details (works on release IDs). For master IDs, use Discogs directly. Use add_to_collection to add a release to your collection.`
	return `${header}\n\n${lines.join('\n\n')}${tip}`
}
