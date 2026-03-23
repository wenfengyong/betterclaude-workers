/**
 * Router module for parsing URL-based routing patterns
 * Patterns:
 * - /claude/{host}/{path} - Proxy to Claude API endpoints
 * - /openai/{host}/{path} - Proxy to OpenAI-compatible API endpoints
 */

export type RouteType = 'claude' | 'openai';

export interface RouteInfo {
	targetHost: string;
	targetPath: string;
	searchParams: string;
	routeType: RouteType;
}

/**
 * Parse URL and extract route information
 * @param url - Request URL to parse
 * @returns RouteInfo object with target host, path, and search params, or null if invalid
 */
export function parseRoute(url: URL): RouteInfo | null {
	// Claude route pattern: /claude/{host}/{path}
	const claudePattern = /^\/claude\/([^\/]+)\/(.*)$/;
	const claudeMatch = url.pathname.match(claudePattern);

	if (claudeMatch) {
		return {
			targetHost: claudeMatch[1],
			targetPath: claudeMatch[2] || '',
			searchParams: url.search,
			routeType: 'claude',
		};
	}

	// OpenAI route pattern: /openai/{host}/{path}
	const openaiPattern = /^\/openai\/([^\/]+)\/(.*)$/;
	const openaiMatch = url.pathname.match(openaiPattern);

	if (openaiMatch) {
		return {
			targetHost: openaiMatch[1],
			targetPath: openaiMatch[2] || '',
			searchParams: url.search,
			routeType: 'openai',
		};
	}

	return null;
}
