import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	type ContentBlock,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";

/**
 * Converts various serialized/plain message formats to proper BaseMessage instances.
 *
 * Extracted from Agent so that both the live agent pipeline and read-only consumers
 * (e.g. the .chat embed preview) share one canonical deserializer.
 *
 * Handles:
 * - Already instantiated BaseMessage objects (have _getType method)
 * - Serialized LangChain format: { id: [...], kwargs: {...} }
 * - StoredMessage format: { type: string, data: {...} }
 * - Plain objects with type field: { type: "human" | "ai" | ... }
 */
export function normalizeMessages(messages: unknown[]): BaseMessage[] {
	const result: BaseMessage[] = [];

	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;

		const normalized = normalizeMessage(msg as Record<string, unknown>);
		if (normalized) {
			result.push(normalized);
		}
	}

	return result;
}

function normalizeMessage(msg: Record<string, unknown>): BaseMessage | undefined {
	// Check if it's already a BaseMessage instance (has _getType method)
	if (typeof (msg as { _getType?: unknown })._getType === "function") {
		return normalizeBaseMessageInstance(msg as Record<string, unknown> & { _getType: () => string });
	}

	// Handle serialized LangChain format: { id: [...], kwargs: {...} }
	if ("kwargs" in msg && typeof msg.kwargs === "object" && msg.kwargs !== null) {
		return convertSerializedLangChainMessage(msg);
	}

	// Handle StoredMessage format: { type: string, data: { content: string, ... } }
	if (typeof msg.type === "string" && msg.data && typeof msg.data === "object") {
		const data = msg.data as Record<string, unknown>;
		return convertPlainMessage(msg.type, {
			...data,
			type: msg.type,
		});
	}

	// Handle plain object with type field (human, ai, system, tool)
	if (typeof msg.type === "string") {
		return convertPlainMessage(msg.type, msg);
	}

	return undefined;
}

function normalizeBaseMessageInstance(
	msg: Record<string, unknown> & { _getType: () => string },
): BaseMessage | undefined {
	const messageType = msg._getType();
	if (messageType === "chat") {
		const role =
			typeof msg.role === "string"
				? msg.role.toLowerCase()
				: typeof msg.name === "string"
					? msg.name.toLowerCase()
					: "assistant";

		if (role === "human" || role === "user") {
			return convertPlainMessage("human", msg);
		}
		if (role === "system" || role === "developer") {
			return convertPlainMessage("system", msg);
		}
		if (role === "tool") {
			return convertPlainMessage("tool", msg);
		}
		return convertPlainMessage("ai", msg);
	}

	return convertPlainMessage(messageType, msg) ?? (msg as unknown as BaseMessage);
}

function convertSerializedLangChainMessage(msg: Record<string, unknown>): BaseMessage | undefined {
	const kwargs = msg.kwargs as Record<string, unknown>;
	const content = extractContent(kwargs);
	const additionalKwargs = asPlainRecord(kwargs.additional_kwargs);
	const responseMetadata = asPlainRecord(kwargs.response_metadata);
	// ID can be a string or an array like ["langchain", "schema", "HumanMessage", "uuid"]
	let id: string | undefined;
	if (typeof kwargs.id === "string") {
		id = kwargs.id;
	} else if (Array.isArray(kwargs.id) && kwargs.id.length > 0) {
		// Take the last element which should be the UUID
		const lastElement = kwargs.id[kwargs.id.length - 1];
		if (typeof lastElement === "string") {
			id = lastElement;
		}
	}

	// Determine type from class name in id array
	const className = readLangChainClassName(msg.id);

	// Cast content — constructors handle both string and ContentBlock[] at runtime
	const c = content as string;

	switch (className) {
		case "HumanMessage":
		case "HumanMessageChunk": {
			const additional_kwargs = (kwargs.additional_kwargs as Record<string, unknown>) ?? undefined;
			return new HumanMessage({ content: c, id, additional_kwargs });
		}
		case "AIMessage":
		case "AIMessageChunk": {
			const toolCalls = extractToolCalls(kwargs);
			return new AIMessage({
				content: c,
				id,
				tool_calls: toolCalls,
				additional_kwargs: additionalKwargs ?? {},
				response_metadata: responseMetadata ?? {},
			});
		}
		case "ChatMessage":
		case "ChatMessageChunk": {
			const normalizedType = normalizeChatMessageType(
				typeof kwargs.role === "string" ? kwargs.role : undefined,
				typeof kwargs.name === "string" ? kwargs.name : undefined,
			);
			return convertPlainMessage(normalizedType, {
				...kwargs,
				id,
			});
		}
		case "SystemMessage":
			return new SystemMessage({ content: c, id });
		case "ToolMessage": {
			const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : "";
			return new ToolMessage({ content: c, tool_call_id: toolCallId, id });
		}
		default:
			// Default to AIMessage for unknown types
			return new AIMessage({
				content: c,
				id,
				additional_kwargs: additionalKwargs ?? {},
				response_metadata: responseMetadata ?? {},
			});
	}
}

function convertPlainMessage(type: string, msg: Record<string, unknown>): BaseMessage | undefined {
	const content = extractContent(msg);
	const id = typeof msg.id === "string" ? msg.id : undefined;
	const additionalKwargs = asPlainRecord(msg.additional_kwargs);
	const responseMetadata = asPlainRecord(msg.response_metadata);

	// Cast content — constructors handle both string and ContentBlock[] at runtime
	const c = content as string;

	switch (type.toLowerCase()) {
		case "human":
		case "humanmessage": {
			const additional_kwargs = (msg.additional_kwargs as Record<string, unknown>) ?? undefined;
			return new HumanMessage({ content: c, id, additional_kwargs });
		}
		case "ai":
		case "aimessage": {
			const toolCalls = extractToolCalls(msg);
			return new AIMessage({
				content: c,
				id,
				tool_calls: toolCalls,
				additional_kwargs: additionalKwargs ?? {},
				response_metadata: responseMetadata ?? {},
			});
		}
		case "system":
		case "systemmessage":
			return new SystemMessage({ content: c, id });
		case "tool":
		case "toolmessage": {
			const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
			return new ToolMessage({ content: c, tool_call_id: toolCallId, id });
		}
		case "chat":
		case "chatmessage":
		case "chatmessagechunk": {
			const normalizedType = normalizeChatMessageType(
				typeof msg.role === "string" ? msg.role : undefined,
				typeof msg.name === "string" ? msg.name : undefined,
			);
			return convertPlainMessage(normalizedType, msg);
		}
		default:
			return undefined;
	}
}

function normalizeChatMessageType(role: string | undefined, name: string | undefined): string {
	const normalizedRole = role?.toLowerCase();
	if (normalizedRole === "human" || normalizedRole === "user") return "human";
	if (normalizedRole === "system" || normalizedRole === "developer") return "system";
	if (normalizedRole === "tool") return "tool";

	const normalizedName = name?.toLowerCase();
	if (normalizedName === "human" || normalizedName === "user") return "human";
	if (normalizedName === "system" || normalizedName === "developer") return "system";
	if (normalizedName === "tool") return "tool";

	return "ai";
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function extractContent(obj: Record<string, unknown>): string | ContentBlock[] {
	const content = obj.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		// Preserve the full array when it has non-text items (e.g. image_url) OR
		// any block tagged as an inlined attachment (s2b_attachment). Attachment
		// blocks are tagged by buildMessageContent so a text-only-attachment array
		// is not silently collapsed into the query string (which would leak the
		// file dump into the UI bubble). The tag is a harmless extra field on a
		// text block — providers ignore unknown content-block fields — so it can
		// ride along through every checkpoint round-trip without being stripped.
		const hasNonTextItems = content.some(
			(c) => c && typeof c === "object" && (c as { type?: unknown }).type !== "text",
		);
		const hasAttachmentBlock = content.some(
			(c) => c && typeof c === "object" && (c as { s2b_attachment?: unknown }).s2b_attachment === true,
		);
		if (hasNonTextItems || hasAttachmentBlock) {
			return content as ContentBlock[];
		}
		// Text-only arrays (no attachments) can be joined into a single string
		return content
			.map((c) => {
				if (typeof c === "string") return c;
				if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
					return (c as { text: string }).text;
				}
				return "";
			})
			.join("");
	}
	return "";
}

function extractToolCalls(
	obj: Record<string, unknown>,
): { id: string; name: string; args: Record<string, unknown> }[] | undefined {
	const directToolCalls = parseToolCalls(obj.tool_calls);
	if (directToolCalls?.length) {
		return directToolCalls;
	}

	const additionalKwargs = asPlainRecord(obj.additional_kwargs);
	return parseToolCalls(additionalKwargs?.tool_calls);
}

function parseToolCalls(toolCalls: unknown): { id: string; name: string; args: Record<string, unknown> }[] | undefined {
	if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;

	return toolCalls
		.filter((tc): tc is Record<string, unknown> => tc && typeof tc === "object")
		.map((tc) => {
			const functionPayload =
				tc.function && typeof tc.function === "object" ? (tc.function as Record<string, unknown>) : undefined;

			return {
				id: typeof tc.id === "string" ? tc.id : "",
				name:
					typeof tc.name === "string"
						? tc.name
						: typeof functionPayload?.name === "string"
							? functionPayload.name
							: "",
				args: parseToolArgs(tc.args ?? tc.arguments ?? functionPayload?.arguments),
			};
		})
		.filter((tc) => tc.name.length > 0);
}

function parseToolArgs(args: unknown): Record<string, unknown> {
	if (typeof args === "string") {
		try {
			return JSON.parse(args) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	if (args && typeof args === "object" && !Array.isArray(args)) {
		return args as Record<string, unknown>;
	}
	return {};
}

function readLangChainClassName(identifier: unknown): string | undefined {
	if (typeof identifier === "string") {
		return identifier.split(":").pop();
	}
	if (Array.isArray(identifier) && typeof identifier[identifier.length - 1] === "string") {
		return identifier[identifier.length - 1] as string;
	}
	return undefined;
}
