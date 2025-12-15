/**
 * Collection Prompts
 * Provides MCP prompts for common Discogs collection workflows
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register collection-related prompts with the MCP server
 */
export function registerPrompts(server: McpServer): void {
	/**
	 * Prompt: browse_collection
	 * Browse and explore your Discogs music collection
	 */
	server.prompt(
		"browse_collection",
		"Browse and explore your Discogs music collection",
		{},
		async () => {
			return {
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: "Help me explore my Discogs music collection. Show me interesting insights, recommend albums to listen to, or help me discover patterns in my collection. You can use the available tools to search my collection, get detailed release information, view collection statistics, and get personalized recommendations.",
						},
					},
				],
			};
		}
	);

	/**
	 * Prompt: find_music
	 * Find specific music in your collection
	 */
	server.prompt(
		"find_music",
		"Find specific music in your collection",
		{
			query: z
				.string()
				.describe(
					"Search query for finding music (artist, album, track, genre, mood, etc.)"
				),
		},
		async ({ query }) => {
			return {
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: `Help me find music in my Discogs collection related to: "${query}". Search through my collection and provide detailed information about any matching releases. If you find multiple matches, help me understand the differences and recommend which ones might be most interesting.`,
						},
					},
				],
			};
		}
	);

	/**
	 * Prompt: collection_insights
	 * Get insights and statistics about your music collection
	 */
	server.prompt(
		"collection_insights",
		"Get insights and statistics about your music collection",
		{},
		async () => {
			return {
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: "Analyze my Discogs music collection and provide interesting insights. Look at my collection statistics, identify patterns in genres, decades, formats, and artists. Help me understand what my collection says about my musical tastes and suggest areas where I might want to expand my collection.",
						},
					},
				],
			};
		}
	);
}
