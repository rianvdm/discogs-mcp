// ABOUTME: KV key helpers for the collection sync subsystem.
// ABOUTME: Centralised here so tests and runtime code can't drift on key shape.

export const snapshotKey = (userId: string) => `collection:snapshot:${userId}`
export const progressKey = (userId: string) => `collection:sync:progress:${userId}`
export const lastForcedFullSyncKey = (userId: string) => `collection:sync:lastForcedFullSync:${userId}`
export const tokenMirrorKey = (userId: string) => `discogs:token:${userId}`
