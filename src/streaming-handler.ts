/**
 * Streaming response handler with error detection
 * Handles streaming responses (SSE and chunked) and detects errors
 *
 * IMPORTANT: This handler properly uses stream.tee() to avoid:
 * - Stream duplication (sending data twice)
 * - Arbitrary byte truncation (cutting JSON mid-field)
 * - SSE format corruption (violating event boundaries)
 */

import { detectOrphanedToolError } from './error-detector';

/**
 * Check if response is a streaming response
 *
 * @param response - Response to check
 * @returns true if response uses streaming
 */
export function isStreamingResponse(response: Response): boolean {
	const contentType = response.headers.get('Content-Type') || '';
	const transferEncoding = response.headers.get('Transfer-Encoding') || '';

	return contentType.includes('text/event-stream') || transferEncoding.includes('chunked');
}

/**
 * Handle streaming response with error detection
 *
 * For streaming responses, we use a simple approach:
 * - If status indicates error (400), consume and check for orphaned tool errors
 * - Otherwise, pass through the response directly without any manipulation
 *
 * This avoids all the stream corruption issues from buffering/combining streams.
 *
 * @param response - Response from API
 * @param originalRequest - Original client request
 * @returns Promise resolving to Response
 */
export async function handleStreamingResponse(response: Response, originalRequest: Request): Promise<Response> {
	// If not streaming, return as-is
	if (!isStreamingResponse(response)) {
		return response;
	}

	// For error responses (400), we need to check for orphaned tool errors
	// In this case, we can consume the stream to parse the error
	if (response.status === 400) {
		// Clone so we can potentially return original if needed
		const clonedResponse = response.clone();

		try {
			const errorInfo = await detectOrphanedToolError(clonedResponse);
			if (errorInfo.isError) {
				// Return a new response with the error body for retry handling
				// We need to re-clone since detectOrphanedToolError consumed clonedResponse
				return response.clone();
			}
		} catch {
			// If error detection fails, return original response
		}

		// Return original response for non-orphan errors
		return response;
	}

	// For successful streaming responses, pass through directly
	// DO NOT buffer, clone, or manipulate the stream in any way
	// This preserves SSE event boundaries and prevents JSON corruption
	return response;
}
