/**
 * Error detection module for orphaned tool_use_id patterns
 * Supports Claude and MiniMax API error formats
 */

export interface ErrorInfo {
	isError: boolean;
	orphanedIds: string[];
	provider: 'claude' | 'minimax' | null;
}

/**
 * Detect orphaned tool_use_id errors in API responses
 *
 * Claude error pattern: "unexpected `tool_use_id` found in `tool_result` blocks: (toolu_\w+)"
 * MiniMax error pattern: "tool result's tool id\(([^)]+)\) not found"
 *
 * @param response - Response from Claude or MiniMax API
 * @returns ErrorInfo with detection results and extracted tool_use_ids
 */
export async function detectOrphanedToolError(response: Response): Promise<ErrorInfo> {
	// Check if response indicates an error (400 Bad Request)
	if (response.status !== 400) {
		return {
			isError: false,
			orphanedIds: [],
			provider: null,
		};
	}

	try {
		// Clone response to preserve body for potential retry
		const clonedResponse = response.clone();
		const body = await clonedResponse.text();

		// Parse response body as JSON
		let errorData: any;
		try {
			errorData = JSON.parse(body);
		} catch {
			// If body is not JSON, return non-error
			return {
				isError: false,
				orphanedIds: [],
				provider: null,
			};
		}

		// Extract error message from response
		const errorMessage = errorData?.error?.message || '';

		// Try Claude pattern first: unexpected `tool_use_id` found in `tool_result` blocks: (toolu_\w+)
		const claudePattern = /unexpected `tool_use_id` found in `tool_result` blocks: (toolu_\w+)/g;
		const claudeMatches = [...errorMessage.matchAll(claudePattern)];

		if (claudeMatches.length > 0) {
			const orphanedIds = claudeMatches.map(match => match[1]);
			return {
				isError: true,
				orphanedIds,
				provider: 'claude',
			};
		}

		// Try MiniMax pattern: tool result's tool id\(([^)]+)\) not found
		const minimaxPattern = /tool result's tool id\(([^)]+)\) not found/g;
		const minimaxMatches = [...errorMessage.matchAll(minimaxPattern)];

		if (minimaxMatches.length > 0) {
			const orphanedIds = minimaxMatches.map(match => match[1]);
			return {
				isError: true,
				orphanedIds,
				provider: 'minimax',
			};
		}

		// No orphaned tool_use_id error detected
		return {
			isError: false,
			orphanedIds: [],
			provider: null,
		};
	} catch (error) {
		// If parsing fails, return non-error
		return {
			isError: false,
			orphanedIds: [],
			provider: null,
		};
	}
}
