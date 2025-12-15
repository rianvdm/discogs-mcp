/**
 * MCP Server configuration for Discogs
 * Uses the official @modelcontextprotocol/sdk with Cloudflare Agents SDK
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../types/env.js";
import { registerPublicTools } from "./tools/public.js";

/**
 * Creates and configures the MCP server with all tools, resources, and prompts
 * Uses factory pattern to provide env access to handlers via closures
 */
export function createServer(env: Env): McpServer {
	const server = new McpServer({
		name: "discogs-mcp",
		version: "1.0.0",
	});

	// Register public tools (available without authentication)
	registerPublicTools(server, env);

	// TODO: Register authenticated tools, resources, and prompts
	// import { registerAuthenticatedTools } from "./tools/authenticated.js";
	// import { registerResources } from "./resources/discogs.js";
	// import { registerPrompts } from "./prompts/collection.js";
	// registerAuthenticatedTools(server, env);
	// registerResources(server, env);
	// registerPrompts(server, env);

	return server;
}
