/**
 * Proxy module for forwarding requests to target APIs
 * Integrates intelligent retry handler for message-based requests
 *
 * Ensures all client information is preserved for upstream servers,
 * including proper handling when upstream uses Cloudflare.
 */

import type { RouteInfo } from './router';
import { retryWithCleanup, type RetryResult } from './retry-handler';

/**
 * Hop-by-hop headers that should not be forwarded
 * These headers are specific to the current connection and shouldn't be passed to upstream
 * Per RFC 2616 Section 13.5.1
 */
const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailers',
	'transfer-encoding',
	'upgrade',
	// Additional headers that shouldn't be forwarded
	'host', // We set this explicitly to target host
]);

/**
 * Headers that are set by our proxy and shouldn't be copied from original request
 * These are overwritten with accurate values from our Cloudflare edge
 */
const PROXY_MANAGED_HEADERS = new Set([
	'x-forwarded-for',
	'x-forwarded-proto',
	'x-forwarded-host',
	'x-real-ip',
	'true-client-ip',
	'cf-connecting-ip',
	'cf-connecting-ipv6',
	'cf-ipcountry',
	'cf-ray',
	'cf-visitor',
	'cf-worker',
	'x-request-id',
]);

/**
 * Build headers for upstream request with full client information preservation
 * Handles both standard proxy headers and Cloudflare-specific headers
 *
 * @param request - Original client request
 * @param targetHost - Target host for the upstream request
 * @returns Headers object ready for upstream request
 */
function buildUpstreamHeaders(request: Request, targetHost: string): Headers {
	const headers = new Headers();

	// Copy all headers from original request except hop-by-hop and proxy-managed
	for (const [key, value] of request.headers.entries()) {
		const lowerKey = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lowerKey) || PROXY_MANAGED_HEADERS.has(lowerKey)) {
			continue;
		}
		headers.set(key, value);
	}

	// Set Host header to target (required for HTTP/1.1)
	headers.set('Host', targetHost);

	// === Client IP Information ===
	// Get the real client IP from Cloudflare (most reliable source)
	const clientIp = request.headers.get('CF-Connecting-IP') || '';
	const clientIpv6 = request.headers.get('CF-Connecting-IPv6') || '';

	if (clientIp) {
		// X-Forwarded-For: Standard proxy header - build the chain
		// Format: client, proxy1, proxy2, ...
		const originalXff = request.headers.get('X-Forwarded-For');
		if (originalXff) {
			// Append our proxy to the chain
			headers.set('X-Forwarded-For', `${originalXff}, ${clientIp}`);
		} else {
			headers.set('X-Forwarded-For', clientIp);
		}

		// X-Real-IP: Original client IP (nginx convention)
		headers.set('X-Real-IP', clientIp);

		// True-Client-IP: Used by some CDNs (Akamai, Cloudflare Enterprise)
		headers.set('True-Client-IP', clientIp);

		// CF-Connecting-IP: Cloudflare's client IP header
		// Important for upstream servers also using Cloudflare
		headers.set('CF-Connecting-IP', clientIp);
	}

	// Forward IPv6 if available
	if (clientIpv6) {
		headers.set('CF-Connecting-IPv6', clientIpv6);
	}

	// === Protocol Information ===
	// Get the original protocol (http/https) the client used
	const cfVisitor = request.headers.get('CF-Visitor');
	let originalProto = 'https'; // Default to https
	if (cfVisitor) {
		try {
			const visitor = JSON.parse(cfVisitor);
			originalProto = visitor.scheme || 'https';
		} catch {
			// Keep default
		}
	}
	headers.set('X-Forwarded-Proto', originalProto);

	// X-Forwarded-Host: Original host requested by client
	const originalHost = request.headers.get('Host') || '';
	if (originalHost) {
		headers.set('X-Forwarded-Host', originalHost);
	}

	// === Cloudflare Geo and Request Information ===
	// Forward geo information for upstream servers that need it
	const cfCountry = request.headers.get('CF-IPCountry');
	if (cfCountry) {
		headers.set('CF-IPCountry', cfCountry);
	}

	// Forward Cloudflare Ray ID for request tracing across services
	const cfRay = request.headers.get('CF-Ray');
	if (cfRay) {
		// Preserve original ray for tracing, add our own prefix
		headers.set('X-Original-CF-Ray', cfRay);
	}

	// Forward CF-Visitor for upstream Cloudflare detection
	if (cfVisitor) {
		headers.set('CF-Visitor', cfVisitor);
	}

	// === Request Identification ===
	// Generate a unique request ID for tracing (if not already present)
	const existingRequestId = request.headers.get('X-Request-ID') || request.headers.get('X-Correlation-ID');
	if (existingRequestId) {
		headers.set('X-Request-ID', existingRequestId);
		headers.set('X-Correlation-ID', existingRequestId);
	} else {
		const requestId = crypto.randomUUID();
		headers.set('X-Request-ID', requestId);
		headers.set('X-Correlation-ID', requestId);
	}

	// === Via Header (RFC 7230) ===
	// Indicates intermediate protocols and recipients
	const existingVia = request.headers.get('Via');
	const viaEntry = '1.1 betterclaude-gateway';
	headers.set('Via', existingVia ? `${existingVia}, ${viaEntry}` : viaEntry);

	return headers;
}

/**
 * Proxy request to target API with header and body preservation
 * Uses intelligent retry handler for requests with messages field
 *
 * @param request - Original client request
 * @param route - Parsed route information
 * @returns RetryResult with response and metadata
 */
export async function proxyRequest(request: Request, route: RouteInfo): Promise<RetryResult> {
	// Construct target URL
	const targetUrl = `https://${route.targetHost}/${route.targetPath}${route.searchParams}`;

	// Build headers with full client information preservation
	const headers = buildUpstreamHeaders(request, route.targetHost);

	// Determine if request should include body (non-GET methods)
	const method = request.method;
	const hasBody = method !== 'GET' && method !== 'HEAD';

	// For requests without body, forward directly
	if (!hasBody) {
		const response = await fetch(targetUrl, {
			method,
			headers,
		});
		return {
			response,
			metadata: {
				removedToolUseIds: [],
				proactiveRemovedIds: [],
				retryCount: 0,
				result: 'success',
			},
		};
	}

	// Fast path: only attempt JSON parsing for JSON-like bodies (or missing content-type)
	const contentType = request.headers.get('Content-Type') || '';
	const looksLikeJson =
		!contentType ||
		contentType.includes('application/json') ||
		contentType.includes('+json') ||
		contentType.includes('text/json');

	if (!looksLikeJson) {
		// Non-JSON body - forward original request stream as-is
		const response = await fetch(targetUrl, {
			method,
			headers,
			body: request.body,
			// @ts-ignore - duplex is valid for streaming support but not in types
			duplex: 'half',
		});
		return {
			response,
			metadata: {
				removedToolUseIds: [],
				proactiveRemovedIds: [],
				retryCount: 0,
				result: 'success',
			},
		};
	}

	let bodyText: string | undefined;
	try {
		bodyText = await request.text();
		const body = JSON.parse(bodyText);

		// If request has messages field, use retry handler
		if (body.messages && Array.isArray(body.messages)) {
			return await retryWithCleanup(request, targetUrl, headers, { text: bodyText, json: body });
		}

		// No messages field - forward request with parsed body
		const response = await fetch(targetUrl, {
			method,
			headers,
			body: bodyText,
			// @ts-ignore - duplex is valid for streaming support but not in types
			duplex: 'half',
		});
		return {
			response,
			metadata: {
				removedToolUseIds: [],
				proactiveRemovedIds: [],
				retryCount: 0,
				result: 'success',
			},
		};
	} catch {
		// Body is not JSON (or couldn't be read as text) - forward best-effort without retry logic
		const response = await fetch(targetUrl, {
			method,
			headers,
			body: bodyText ?? request.body,
			// @ts-ignore - duplex is valid for streaming support but not in types
			duplex: 'half',
		});
		return {
			response,
			metadata: {
				removedToolUseIds: [],
				proactiveRemovedIds: [],
				retryCount: 0,
				result: 'success',
			},
		};
	}
}
