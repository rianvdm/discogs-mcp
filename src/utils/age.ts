// ABOUTME: Coarse "how long ago" formatting for status lines, shared by the relay
// ABOUTME: egress report and the collection sync summary.

/** "just now", "4 min ago", "3 h ago", "2 d ago" — coarse on purpose, this is a status line. */
export function describeAge(sinceMs: number, now: number): string {
	const s = Math.max(0, Math.round((now - sinceMs) / 1000))
	if (s < 60) return 'just now'
	const m = Math.round(s / 60)
	if (m < 60) return `${m} min ago`
	const h = Math.round(m / 60)
	if (h < 24) return `${h} h ago`
	return `${Math.round(h / 24)} d ago`
}
