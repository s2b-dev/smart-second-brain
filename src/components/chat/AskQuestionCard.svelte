<script lang="ts">
import {
	getPendingQuestionStore,
	type QuestionAnswerPayload,
	type QuestionItem,
} from "../../stores/pendingQuestionStore.svelte";
import Icon from "../ui/Icon.svelte";

interface Props {
	toolCallId: string;
	input?: Record<string, unknown> | null;
}

const { toolCallId, input }: Props = $props();

const pendingStore = getPendingQuestionStore();

// Derive questions from the reactive pending question store, falling back to tool input
const questions = $derived.by((): QuestionItem[] => {
	const fromStore = pendingStore.getPending(toolCallId)?.questions;
	if (fromStore && fromStore.length > 0) return fromStore;

	if (input?.questions && Array.isArray(input.questions)) {
		return (input.questions as Array<Record<string, unknown>>).map((q, idx) => ({
			id: typeof q.id === "string" && q.id ? q.id : `q_${idx + 1}`,
			question: typeof q.question === "string" ? q.question : "",
			options: Array.isArray(q.options) ? (q.options as string[]) : [],
			isMultiSelect: Boolean(q.is_multi_select),
			allowCustom: q.allow_custom !== false,
		}));
	}
	return [];
});

// State for selected options: questionId -> array of selected option strings
let selections = $state<Record<string, string[]>>({});
// State for custom write-in answers: questionId -> custom text string
let customTexts = $state<Record<string, string>>({});
// State for whether the "Other" card is expanded/active for a question
let otherActive = $state<Record<string, boolean>>({});
let isSubmitted = $state(false);

function toggleOption(question: QuestionItem, option: string) {
	if (isSubmitted) return;
	const qId = question.id;
	const current = selections[qId] ?? [];

	if (question.isMultiSelect) {
		if (current.includes(option)) {
			selections[qId] = current.filter((o) => o !== option);
		} else {
			selections[qId] = [...current, option];
		}
	} else {
		// Single choice: select option and deactivate custom other if active
		if (current.includes(option)) {
			selections[qId] = [];
		} else {
			selections[qId] = [option];
			otherActive[qId] = false;
		}
	}
}

function toggleOther(question: QuestionItem) {
	if (isSubmitted) return;
	const qId = question.id;
	const willBeActive = !otherActive[qId];
	otherActive[qId] = willBeActive;

	if (willBeActive && !question.isMultiSelect) {
		// Single choice: deselect other standard options
		selections[qId] = [];
	}
}

function handleCustomInput(qId: string, text: string) {
	customTexts[qId] = text;
	otherActive[qId] = true;
	const q = questions.find((item) => item.id === qId);
	if (q && !q.isMultiSelect) {
		selections[qId] = [];
	}
}

const canSubmit = $derived.by(() => {
	if (questions.length === 0) return false;
	return questions.every((q) => {
		const hasSelected = (selections[q.id]?.length ?? 0) > 0;
		const isOtherSelected = Boolean(otherActive[q.id]) && (customTexts[q.id]?.trim().length ?? 0) > 0;
		return hasSelected || isOtherSelected;
	});
});

function handleSubmit() {
	if (!canSubmit || isSubmitted) return;
	isSubmitted = true;

	const answers: QuestionAnswerPayload[] = questions.map((q) => {
		const selected = selections[q.id] ?? [];
		const customText = otherActive[q.id] ? customTexts[q.id]?.trim() || undefined : undefined;
		return {
			questionId: q.id,
			question: q.question,
			selected,
			customText,
		};
	});

	pendingStore.submitAnswers(toolCallId, answers);
}
</script>

<div class="ask-question-card rounded-xl border border-[--background-modifier-border] bg-[--background-secondary] p-4 my-2.5 text-[--text-normal] shadow-xs">
	<!-- Top indicator row -->
	<div class="flex items-center justify-between gap-2 mb-3.5 pb-2 border-b border-[--background-modifier-border]">
		<div class="flex items-center gap-2 text-xs font-medium text-[--text-accent]">
			<Icon name="help-circle" size="s" />
			<span>Question for you</span>
		</div>
		<span class="text-xs text-[--text-muted]">
			{questions.length > 1 ? `${questions.length} questions` : "Response needed"}
		</span>
	</div>

	{#if questions.length === 0}
		<div class="text-xs text-[--text-muted] py-4 text-center">Waiting for questions...</div>
	{:else}
		<div class="space-y-5">
			{#each questions as q, qIndex (q.id)}
				{@const qId = q.id}
				{@const currentSelections = selections[qId] ?? []}
				{@const isOtherOpen = Boolean(otherActive[qId])}

				<div class="question-block">
					<!-- Question Title -->
					<div class="mb-3">
						<div class="text-sm font-semibold text-[--text-normal] leading-snug">
							{#if questions.length > 1}
								<span class="text-[--text-muted] font-normal mr-1">{qIndex + 1}.</span>
							{/if}
							{q.question}
						</div>
						<div class="text-xs text-[--text-muted] mt-1">
							{q.isMultiSelect ? "Select one or more options" : "Select one option"}
						</div>
					</div>

					<!-- Option Cards Stack -->
					<div class="options-list flex flex-col gap-2.5 mt-2">
						{#each q.options as opt}
							{@const isSelected = currentSelections.includes(opt)}
							<button
								type="button"
								class="option-card {isSelected ? 'option-card-selected' : ''}"
								onclick={() => toggleOption(q, opt)}
								disabled={isSubmitted}
							>
								<!-- Large Checkbox/Radio Indicator Box -->
								<div class="indicator-wrapper">
									{#if q.isMultiSelect}
										<div class="indicator-box indicator-box-checkbox {isSelected ? 'indicator-box-active' : ''}">
											{#if isSelected}
												<svg class="indicator-check" viewBox="0 0 24 24" fill="none" stroke="currentColor">
													<polyline points="20 6 9 17 4 12"></polyline>
												</svg>
											{/if}
										</div>
									{:else}
										<div class="indicator-box indicator-box-radio {isSelected ? 'indicator-box-active-radio' : ''}">
											{#if isSelected}
												<div class="indicator-dot"></div>
											{/if}
										</div>
									{/if}
								</div>

								<!-- Option Label -->
								<div class="option-label {isSelected ? 'option-label-selected' : ''}">
									{opt}
								</div>
							</button>
						{/each}

						<!-- Custom "Other" Option -->
						{#if q.allowCustom}
							<div class="option-card-other {isOtherOpen ? 'option-card-selected' : ''}">
								<button
									type="button"
									class="option-other-header"
									onclick={() => toggleOther(q)}
									disabled={isSubmitted}
								>
									<div class="indicator-wrapper">
										{#if q.isMultiSelect}
											<div class="indicator-box indicator-box-checkbox {isOtherOpen ? 'indicator-box-active' : ''}">
												{#if isOtherOpen}
													<svg class="indicator-check" viewBox="0 0 24 24" fill="none" stroke="currentColor">
														<polyline points="20 6 9 17 4 12"></polyline>
													</svg>
												{/if}
											</div>
										{:else}
											<div class="indicator-box indicator-box-radio {isOtherOpen ? 'indicator-box-active-radio' : ''}">
												{#if isOtherOpen}
													<div class="indicator-dot"></div>
												{/if}
											</div>
										{/if}
									</div>

									<div class="option-label {isOtherOpen ? 'option-label-selected' : ''}">
										Other (type your own answer)
									</div>
								</button>

								{#if isOtherOpen}
									<div class="other-input-container">
										<input
											type="text"
											placeholder="Type your response..."
											value={customTexts[qId] ?? ""}
											oninput={(e) => handleCustomInput(qId, (e.target as HTMLInputElement).value)}
											disabled={isSubmitted}
											class="other-text-input"
										/>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<!-- Footer Submit Row -->
		<div class="mt-4 pt-3 flex items-center justify-between border-t border-[--background-modifier-border]">
			<span class="text-xs text-[--text-muted]">
				{#if canSubmit}
					Ready to submit
				{:else}
					Select an option to continue
				{/if}
			</span>

			<button
				type="button"
				class="mod-cta px-4 py-2 rounded-md text-xs font-semibold cursor-pointer transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
				onclick={handleSubmit}
				disabled={!canSubmit || isSubmitted}
			>
				{isSubmitted ? "Submitting..." : "Submit response"}
			</button>
		</div>
	{/if}
</div>

<style>
.ask-question-card,
.ask-question-card * {
	pointer-events: auto !important;
	box-sizing: border-box !important;
}

.ask-question-card {
	animation: slideFadeIn 0.18s ease-out;
	overflow: visible !important;
}

@keyframes slideFadeIn {
	from {
		opacity: 0;
		transform: translateY(3px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}

/* ── Option Cards (override Obsidian button defaults to prevent height/whitespace clipping) ── */
button.option-card,
.option-card {
	display: flex !important;
	flex-direction: row !important;
	align-items: flex-start !important;
	width: 100% !important;
	height: auto !important;
	min-height: 48px !important;
	max-height: none !important;
	padding: 12px 14px !important;
	margin: 0 !important;
	border-radius: 8px !important;
	border: 1px solid var(--background-modifier-border) !important;
	background-color: var(--background-primary) !important;
	color: var(--text-normal) !important;
	text-align: left !important;
	white-space: normal !important;
	overflow: visible !important;
	box-shadow: none !important;
	cursor: pointer !important;
	gap: 12px !important;
	transition: all 0.15s ease !important;
}

button.option-card:hover,
.option-card:hover {
	background-color: var(--background-modifier-hover) !important;
	border-color: var(--interactive-accent) !important;
}

.option-card-selected {
	background-color: var(--background-modifier-active-hover) !important;
	border-color: var(--interactive-accent) !important;
	box-shadow: 0 0 0 1px var(--interactive-accent) !important;
}

/* ── Indicator Box (Checkbox & Radio) ── */
.indicator-wrapper {
	flex: 0 0 22px !important;
	width: 22px !important;
	height: 22px !important;
	min-width: 22px !important;
	min-height: 22px !important;
	display: flex !important;
	align-items: center !important;
	justify-content: center !important;
	margin-top: 1px !important;
	overflow: visible !important;
}

.indicator-box {
	width: 22px !important;
	height: 22px !important;
	min-width: 22px !important;
	min-height: 22px !important;
	border: 2px solid var(--text-faint) !important;
	background-color: var(--background-primary) !important;
	display: flex !important;
	align-items: center !important;
	justify-content: center !important;
	transition: all 0.15s ease !important;
	overflow: visible !important;
	box-sizing: border-box !important;
}

.option-card:hover .indicator-box,
.option-card-other:hover .indicator-box {
	border-color: var(--interactive-accent) !important;
}

.indicator-box-checkbox {
	border-radius: 6px !important;
}

.indicator-box-radio {
	border-radius: 50% !important;
}

.indicator-box-active {
	background-color: var(--interactive-accent) !important;
	border-color: var(--interactive-accent) !important;
}

.indicator-box-active-radio {
	border-color: var(--interactive-accent) !important;
	background-color: var(--background-primary) !important;
}

.indicator-dot {
	width: 10px !important;
	height: 10px !important;
	min-width: 10px !important;
	min-height: 10px !important;
	border-radius: 50% !important;
	background-color: var(--interactive-accent) !important;
}

.indicator-check {
	width: 14px !important;
	height: 14px !important;
	color: var(--text-on-accent) !important;
	stroke-width: 3.5 !important;
	display: block !important;
}

/* ── Option Text ── */
.option-label {
	flex: 1 1 auto !important;
	font-size: 0.88rem !important;
	line-height: 1.45 !important;
	color: var(--text-muted) !important;
	white-space: normal !important;
	word-break: break-word !important;
	overflow-wrap: break-word !important;
	overflow: visible !important;
	padding-top: 1px !important;
}

.option-label-selected {
	color: var(--text-normal) !important;
	font-weight: 500 !important;
}

/* ── "Other" Custom Container ── */
.option-card-other {
	display: flex !important;
	flex-direction: column !important;
	width: 100% !important;
	height: auto !important;
	min-height: 48px !important;
	max-height: none !important;
	padding: 12px 14px !important;
	border-radius: 8px !important;
	border: 1px solid var(--background-modifier-border) !important;
	background-color: var(--background-primary) !important;
	overflow: visible !important;
	transition: all 0.15s ease !important;
}

.option-card-other:hover {
	border-color: var(--interactive-accent) !important;
}

button.option-other-header {
	display: flex !important;
	align-items: flex-start !important;
	width: 100% !important;
	height: auto !important;
	min-height: 24px !important;
	max-height: none !important;
	padding: 0 !important;
	margin: 0 !important;
	background: transparent !important;
	border: 0 !important;
	box-shadow: none !important;
	cursor: pointer !important;
	gap: 12px !important;
	text-align: left !important;
	white-space: normal !important;
}

.other-input-container {
	margin-top: 10px !important;
	padding-left: 34px !important;
	width: 100% !important;
}

.other-text-input {
	width: 100% !important;
	height: var(--input-height, 34px) !important;
	font-size: 0.82rem !important;
	padding: 6px 12px !important;
	border-radius: 6px !important;
	background-color: var(--background-secondary) !important;
	border: 1px solid var(--background-modifier-border) !important;
	color: var(--text-normal) !important;
	outline: none !important;
}

.other-text-input:focus {
	border-color: var(--interactive-accent) !important;
	box-shadow: 0 0 0 1px var(--interactive-accent) !important;
}
</style>
