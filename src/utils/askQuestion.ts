/**
 * The `ask_question` tool's data model: what the model sends, what the user answers, and
 * the text the model reads back. Pure and store-free, so the tool, the chat store and the
 * question bar all share one definition.
 *
 * The tool never runs. LangChain's human-in-the-loop middleware pauses the call and the
 * user's answer becomes the tool result (a `respond` decision), so the strings built here
 * are that result. They are JSON so the chat can show a settled question from the
 * checkpoint alone, with no state of its own.
 */

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 4;

export interface AskQuestionOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	question: string;
	/** A few words naming the topic; labels the question's tab when several are asked. */
	header?: string;
	options: AskQuestionOption[];
	multiSelect: boolean;
}

/** One question's answer: the option labels picked, plus anything the user typed. */
export interface QuestionAnswer {
	selected: string[];
	custom?: string;
}

export type AskQuestionResult =
	| { status: "answered"; answers: { question: string; answer: string[] }[] }
	/** The user typed a message in the chat input instead of using the options. */
	| { status: "replied"; reply: string }
	| { status: "dismissed" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOption(raw: unknown): AskQuestionOption | null {
	// A bare string is not what the schema asks for, but weaker models send it; the label
	// is all an option needs.
	if (typeof raw === "string") return raw.trim() ? { label: raw.trim() } : null;
	if (!isRecord(raw) || typeof raw.label !== "string" || !raw.label.trim()) return null;
	const description = typeof raw.description === "string" ? raw.description.trim() : "";
	return { label: raw.label.trim(), ...(description ? { description } : {}) };
}

/**
 * Reads a call's arguments into questions, dropping malformed items rather than failing:
 * the arguments come from the model, and from checkpoints written by older versions.
 * Duplicate option labels are dropped too, since an answer is recorded by label.
 */
export function parseAskQuestions(input: unknown): AskQuestion[] {
	const raw = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
	const questions: AskQuestion[] = [];
	for (const item of raw) {
		if (!isRecord(item) || typeof item.question !== "string" || !item.question.trim()) continue;
		const seen = new Set<string>();
		const options: AskQuestionOption[] = [];
		for (const rawOption of Array.isArray(item.options) ? item.options : []) {
			const option = parseOption(rawOption);
			if (!option || seen.has(option.label)) continue;
			seen.add(option.label);
			options.push(option);
		}
		const header = typeof item.header === "string" ? item.header.trim() : "";
		questions.push({
			question: item.question.trim(),
			...(header ? { header } : {}),
			options,
			multiSelect: item.multiSelect === true,
		});
	}
	return questions;
}

export function isAnswered(answer: QuestionAnswer | undefined): boolean {
	return Boolean(answer && (answer.selected.length > 0 || answer.custom?.trim()));
}

function answerValues(answer: QuestionAnswer | undefined): string[] {
	if (!answer) return [];
	const custom = answer.custom?.trim();
	return custom ? [...answer.selected, custom] : [...answer.selected];
}

/** The tool result for a submitted card. `answers` is index-aligned with `questions`. */
export function formatAnswersResult(questions: AskQuestion[], answers: (QuestionAnswer | undefined)[]): string {
	return JSON.stringify({
		status: "answered",
		answers: questions.map((q, i) => ({ question: q.question, answer: answerValues(answers[i]) })),
	});
}

/**
 * The tool result when the user answered by typing a chat message instead. `context` is
 * what the composer attached to that message (open notes, a selection), kept apart from
 * the reply so the chat shows the user's words alone.
 */
export function formatReplyResult(reply: string, context?: string): string {
	return JSON.stringify({
		status: "replied",
		reply: reply.trim(),
		...(context?.trim() ? { context: context.trim() } : {}),
		note: "The user did not pick from the options and replied in their own words instead. Treat the reply as their answer.",
	});
}

/** The tool result when the user closed the question without answering. */
export function formatDismissedResult(): string {
	return JSON.stringify({
		status: "dismissed",
		note: "The user closed the question without answering. Do not ask it again. Continue with your best judgement if that is safe, otherwise say briefly what you need from them and stop.",
	});
}

/** The tool result for a call whose arguments held no question the chat could show. */
export function formatInvalidResult(): string {
	return JSON.stringify({
		status: "dismissed",
		note: "The call held no valid question, so nothing was shown to the user. Call the tool again with at least one question that has a question text and 2 or more options.",
	});
}

/** Reads a settled call's output back. Returns null for output that is not one of ours. */
export function parseAskQuestionResult(output: unknown): AskQuestionResult | null {
	let value = output;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!isRecord(value)) return null;
	if (value.status === "dismissed") return { status: "dismissed" };
	if (value.status === "replied" && typeof value.reply === "string") {
		return { status: "replied", reply: value.reply };
	}
	if (value.status === "answered" && Array.isArray(value.answers)) {
		const answers: { question: string; answer: string[] }[] = [];
		for (const item of value.answers) {
			if (!isRecord(item) || typeof item.question !== "string") continue;
			const answer = Array.isArray(item.answer)
				? item.answer.filter((a): a is string => typeof a === "string")
				: [];
			answers.push({ question: item.question, answer });
		}
		return { status: "answered", answers };
	}
	return null;
}
