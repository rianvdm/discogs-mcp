// ABOUTME: Tool annotation presets that tell MCP clients which tools read, which write, and which discard data.
// ABOUTME: The spec defaults destructiveHint to true for any non-read-only tool, so writes must opt out explicitly.
import type { ToolAnnotations } from '@modelcontextprotocol/server'

/** Reads Discogs or server state and changes nothing. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true }

/** Adds or updates data in a way the user can undo by hand. */
export const ADDITIVE_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false }

/** Removes or overwrites user-authored data; a client may want to confirm first. */
export const DESTRUCTIVE_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true }
