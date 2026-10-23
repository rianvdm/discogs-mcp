// ABOUTME: The MCP protocol revision this server speaks natively, for the hand-maintained surfaces that advertise it.
// ABOUTME: The SDK negotiates the wire version itself; this constant only feeds server_info and the discovery card.

/**
 * The stateless MCP revision the server speaks natively. Older clients still
 * negotiate the legacy `initialize` lane through the SDK's compatibility fallback.
 *
 * Kept as a repo constant because @modelcontextprotocol/server exports
 * LATEST_PROTOCOL_VERSION as the latest *legacy* revision, not this one.
 */
export const PROTOCOL_VERSION = '2026-07-28'
