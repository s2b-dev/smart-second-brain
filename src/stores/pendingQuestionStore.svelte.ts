import { SvelteMap } from "svelte/reactivity";
import { genUUIDv7 } from "../utils/uuid7Validator";
import { Logger } from "../utils/logging";

export interface QuestionItem {
	id: string;
	question: string;
	options: string[];
	isMultiSelect?: boolean;
	allowCustom?: boolean;
}

export interface QuestionAnswerPayload {
	questionId: string;
	question: string;
	selected: string[];
	customText?: string;
}

export interface PendingQuestionEntry {
	id: string;
	threadId: string;
	toolCallId: string;
	questions: QuestionItem[];
	resolve: (answers: QuestionAnswerPayload[]) => void;
	reject: (error: Error) => void;
	createdAt: number;
}

export class PendingQuestionStore {
	private pendingByToolCallId = new SvelteMap<string, PendingQuestionEntry>();

	/**
	 * Registers a pending question and returns a Promise that resolves when the user submits answers.
	 */
	ask(
		threadId: string,
		toolCallId: string,
		questions: QuestionItem[],
		signal?: AbortSignal,
	): Promise<QuestionAnswerPayload[]> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Tool execution was aborted"));
		}

		return new Promise<QuestionAnswerPayload[]>((resolve, reject) => {
			const id = genUUIDv7();
			const entry: PendingQuestionEntry = {
				id,
				threadId,
				toolCallId,
				questions,
				resolve: (answers) => {
					this.pendingByToolCallId.delete(toolCallId);
					resolve(answers);
				},
				reject: (err) => {
					this.pendingByToolCallId.delete(toolCallId);
					reject(err);
				},
				createdAt: Date.now(),
			};

			if (signal) {
				const onAbort = () => {
					signal.removeEventListener("abort", onAbort);
					if (this.pendingByToolCallId.has(toolCallId)) {
						entry.reject(new Error("Tool execution was aborted"));
					}
				};
				signal.addEventListener("abort", onAbort, { once: true });
			}

			this.pendingByToolCallId.set(toolCallId, entry);
			Logger.debug("[PendingQuestionStore] Question registered", {
				threadId,
				toolCallId,
				questionCount: questions.length,
			});
		});
	}

	private findEntry(key: string): PendingQuestionEntry | undefined {
		if (!key) {
			if (this.pendingByToolCallId.size === 1) {
				return this.pendingByToolCallId.values().next().value;
			}
			return undefined;
		}
		const direct = this.pendingByToolCallId.get(key);
		if (direct) return direct;

		for (const entry of this.pendingByToolCallId.values()) {
			if (entry.id === key || entry.toolCallId === key || entry.threadId === key) {
				return entry;
			}
		}

		if (this.pendingByToolCallId.size === 1) {
			return this.pendingByToolCallId.values().next().value;
		}
		return undefined;
	}

	/**
	 * Submits answers for a pending question.
	 */
	submitAnswers(toolCallId: string, answers: QuestionAnswerPayload[]): boolean {
		const entry = this.findEntry(toolCallId);
		if (!entry) {
			Logger.warn("[PendingQuestionStore] No pending question found for toolCallId", toolCallId);
			return false;
		}
		entry.resolve(answers);
		return true;
	}

	/**
	 * Cancels a pending question.
	 */
	cancel(toolCallId: string, error?: Error): boolean {
		const entry = this.findEntry(toolCallId);
		if (!entry) return false;
		entry.reject(error ?? new Error("Question was cancelled"));
		return true;
	}

	/**
	 * Returns the pending question for a specific tool call.
	 */
	getPending(toolCallId: string): PendingQuestionEntry | undefined {
		return this.findEntry(toolCallId);
	}

	/**
	 * Returns any pending question for a given thread.
	 */
	getPendingForThread(threadId: string): PendingQuestionEntry | undefined {
		for (const entry of this.pendingByToolCallId.values()) {
			if (entry.threadId === threadId) return entry;
		}
		return undefined;
	}

	/**
	 * Clears and rejects any pending questions for a thread.
	 */
	clearForThread(threadId: string): void {
		for (const [toolCallId, entry] of Array.from(this.pendingByToolCallId.entries())) {
			if (entry.threadId === threadId) {
				entry.reject(new Error("Thread session cleared or reset"));
				this.pendingByToolCallId.delete(toolCallId);
			}
		}
	}
}

let _pendingQuestionStore: PendingQuestionStore | null = null;

export function getPendingQuestionStore(): PendingQuestionStore {
	if (!_pendingQuestionStore) {
		_pendingQuestionStore = new PendingQuestionStore();
	}
	return _pendingQuestionStore;
}

export function initPendingQuestionStore(store: PendingQuestionStore): void {
	_pendingQuestionStore = store;
}
