/**
 * Proactive cleanup module for detecting and removing orphaned tool_result blocks
 * Scans all messages before API call to prevent orphaned tool_use_id errors
 */

/**
 * Content block types in Claude/MiniMax API messages
 */
export interface ContentBlock {
	type: 'text' | 'tool_use' | 'tool_result';
	text?: string;
	id?: string; // For tool_use blocks
	tool_use_id?: string; // For tool_result blocks
	name?: string;
	input?: any;
	content?: string | ContentBlock[];
}

/**
 * Message structure in Claude/MiniMax API requests
 */
export interface Message {
	role: 'user' | 'assistant' | 'system';
	content: ContentBlock[];
}

/**
 * Result of proactive cleanup operation
 */
export interface CleanupResult {
	cleanedMessages: Message[];
	removedIds: string[];
	hadOrphans: boolean;
}

/**
 * Detect and remove ALL orphaned tool_result blocks from messages BEFORE API call
 *
 * This is the proactive approach: clean up all potential issues BEFORE sending
 * to the API, rather than retrying after getting errors.
 *
 * Process:
 * 1. Scan ALL messages to collect valid tool_use IDs
 * 2. Scan ALL messages to find tool_result blocks
 * 3. Check if each tool_result's tool_use_id exists in valid set
 * 4. Remove ALL orphaned tool_result blocks in one pass
 *
 * Supports both Claude (toolu_xxx) and MiniMax (call_function_xxx) ID patterns
 *
 * @param messages - Array of messages from conversation history
 * @returns CleanupResult with cleaned messages and metadata
 */
export function detectAndRemoveOrphanedToolResults(messages: Message[]): CleanupResult {
	// Phase 1: Collect all valid tool_use IDs from ALL messages
	// (not just assistant messages - safety first)
	const validToolUseIds = new Set<string>();

	for (const message of messages) {
		for (const block of message.content) {
			if (block.type === 'tool_use' && block.id) {
				validToolUseIds.add(block.id);
			}
		}
	}

	// Phase 2: Scan all messages for orphaned tool_result blocks
	const orphanedIds: string[] = [];

	for (const message of messages) {
		for (const block of message.content) {
			if (block.type === 'tool_result' && block.tool_use_id) {
				// Check if this tool_result references a valid tool_use
				if (!validToolUseIds.has(block.tool_use_id)) {
					orphanedIds.push(block.tool_use_id);
				}
			}
		}
	}

	// If no orphaned tool_results found, return original messages
	if (orphanedIds.length === 0) {
		return {
			cleanedMessages: messages,
			removedIds: [],
			hadOrphans: false,
		};
	}

	// Phase 3: Remove ALL orphaned tool_result blocks from messages
	const orphanedIdsSet = new Set(orphanedIds);
	const cleanedMessages = structuredClone(messages);

	for (const message of cleanedMessages) {
		// Filter out orphaned tool_result blocks
		message.content = message.content.filter(block => {
			if (block.type === 'tool_result' && block.tool_use_id) {
				return !orphanedIdsSet.has(block.tool_use_id);
			}
			return true;
		});
	}

	return {
		cleanedMessages,
		removedIds: orphanedIds,
		hadOrphans: true,
	};
}
