/**
 * Router module for parsing URL-based routing patterns
 * Pattern: /claude/{host}/{path}
 */

export interface RouteInfo {
	targetHost: string;
	targetPath: string;
	searchParams: string;
}

/**
 * Parse URL and extract route information
 * @param url - Request URL to parse
 * @returns RouteInfo object with target host, path, and search params, or null if invalid
 */
export function parseRoute(url: URL): RouteInfo | null {
	const pattern = /^\/claude\/([^\/]+)\/(.*)$/;
	const match = url.pathname.match(pattern);

	if (!match) {
		return null;
	}

	const targetHost = match[1];
	const targetPath = match[2] || '';
	const searchParams = url.search;

	return {
		targetHost,
		targetPath,
		searchParams,
	};
}
