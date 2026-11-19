<script lang="ts">
import { Notice } from "obsidian";
import { untrack } from "svelte";
import type { ToolInterrupt } from "../../agent/toolInterrupts";
import type { ChatSession } from "../../stores/chatStore.svelte";
import {
	type AskQuestion,
	type QuestionAnswer,
	formatAnswersResult,
	formatDismissedResult,
	formatInvalidResult,
	isAnswered,
	parseAskQuestions,
} from "../../utils/askQuestion";
import { icon } from "../../utils/utils";

interface Props {
	session: ChatSession;
	interrupts: ToolInterrupt[];
}

const { session, interrupts }: Props = $props();

interface Step {
	interruptId: string;
	question: AskQuestion;
}

// Every question of every paused call, as one sequence of steps. The model is told to
// ask in a single call, but two parallel calls must still both be answered before the
// run can continue, so they are simply walked through together.
// Read once: QuestionBar keys this component on the set of open questions, so a new
// set mounts a new form rather than updating this one.
const steps: Step[] = untrack(() => interrupts).flatMap((interrupt) =>
	parseAskQuestions(interrupt.args).map((question) => ({ interruptId: interrupt.id, question })),
);

let answers = $state<QuestionAnswer[]>(steps.map(() => ({ selected: [], custom: "" })));
let index = $state(0);
let submitting = $state(false);

const step = $derived(steps[index]);
const answer = $derived(answers[index]);
const isLast = $derived(index === steps.length - 1);
const allAnswered = $derived(answers.every((a) => isAnswered(a)));

function resultFor(interrupt: ToolInterrupt): string {
	const questions: AskQuestion[] = [];
	const given: QuestionAnswer[] = [];
	steps.forEach((s, i) => {
		if (s.interruptId !== interrupt.id) return;
		questions.push(s.question);
		given.push(answers[i]);
	});
	return questions.length > 0 ? formatAnswersResult(questions, given) : formatInvalidResult();
}

async function resume(result: (interrupt: ToolInterrupt) => string) {
	if (submitting) return;
	submitting = true;
	try {
		await session.answerInterrupts(result);
	} catch (error) {
		submitting = false;
		new Notice(error instanceof Error ? error.message : "Could not send your answer");
	}
}

function submit() {
	if (!allAnswered) return;
	void resume(resultFor);
}

function dismiss() {
	void resume(() => formatDismissedResult());
}

function advance() {
	if (!isAnswered(answer)) return;
	if (isLast) submit();
	else index += 1;
}

function pick(label: string) {
	if (step.question.multiSelect) {
		answer.selected = answer.selected.includes(label)
			? answer.selected.filter((l) => l !== label)
			: [...answer.selected, label];
		return;
	}
	// One choice answers the question, so picking it moves on: to the next question,
	// or straight to the agent when it was the only one. A multi-question form stops
	// on its last step so the user can still go back before sending.
	answer.selected = [label];
	answer.custom = "";
	if (steps.length === 1) submit();
	else if (!isLast) index += 1;
}

function onCustomInput(event: Event) {
	answer.custom = (event.currentTarget as HTMLInputElement).value;
	// Typed text replaces a single choice; with multi-select it is one more answer.
	if (!step.question.multiSelect && answer.custom.trim()) answer.selected = [];
}

function onCustomKeydown(event: KeyboardEvent) {
	if (event.key !== "Enter" || event.isComposing) return;
	event.preventDefault();
	advance();
}

function optionIcon(selected: boolean, multi: boolean): string {
	if (multi) return selected ? "square-check" : "square";
	return selected ? "circle-dot" : "circle";
}
</script>

<div class="s2b-question-bar" role="group" aria-label="Question from the agent">
  <div class="s2b-question-head">
    <div class="s2b-question-icon" use:icon={"message-circle-question"} style="--icon-size: var(--icon-xs)"></div>
    <span class="s2b-question-meta">
      {#if steps.length > 1}
        Question {index + 1} of {steps.length}{step.question.header ? ` · ${step.question.header}` : ""}
      {:else if step?.question.header}
        {step.question.header}
      {:else}
        Question
      {/if}
    </span>
    <button
      class="s2b-question-dismiss clickable-icon"
      type="button"
      aria-label="Dismiss question"
      title="Dismiss without answering"
      disabled={submitting}
      onclick={dismiss}
    >
      <div use:icon={"x"} style="--icon-size: var(--icon-xs)"></div>
    </button>
  </div>

  {#if step}
    <div class="s2b-question-text">{step.question.question}</div>
    {#if step.question.multiSelect}
      <div class="s2b-question-hint">Select all that apply</div>
    {/if}

    <div class="s2b-question-options">
      {#each step.question.options as option (option.label)}
        {@const selected = answer.selected.includes(option.label)}
        <button
          class="s2b-question-option"
          class:s2b-question-option-selected={selected}
          type="button"
          role={step.question.multiSelect ? "checkbox" : "radio"}
          aria-checked={selected}
          disabled={submitting}
          onclick={() => pick(option.label)}
        >
          <div
            class="s2b-question-option-icon"
            use:icon={optionIcon(selected, step.question.multiSelect)}
            style="--icon-size: var(--icon-s)"
          ></div>
          <span class="s2b-question-option-body">
            <span class="s2b-question-option-label">{option.label}</span>
            {#if option.description}
              <span class="s2b-question-option-desc">{option.description}</span>
            {/if}
          </span>
        </button>
      {/each}
      <input
        class="s2b-question-custom"
        type="text"
        placeholder={step.question.options.length > 0 ? "Something else…" : "Type your answer…"}
        aria-label="Your own answer"
        value={answer.custom}
        disabled={submitting}
        oninput={onCustomInput}
        onkeydown={onCustomKeydown}
      />
    </div>

    {#if steps.length > 1 || step.question.multiSelect || answer.custom?.trim()}
      <div class="s2b-question-actions">
        {#if index > 0}
          <button type="button" disabled={submitting} onclick={() => (index -= 1)}>Back</button>
        {/if}
        {#if isLast}
          <button class="mod-cta" type="button" disabled={!allAnswered || submitting} onclick={submit}>
            {steps.length > 1 ? "Send answers" : "Send answer"}
          </button>
        {:else}
          <button class="mod-cta" type="button" disabled={!isAnswered(answer) || submitting} onclick={advance}>
            Next
          </button>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="s2b-question-text">The agent asked a question that could not be shown.</div>
    <div class="s2b-question-actions">
      <button class="mod-cta" type="button" disabled={submitting} onclick={() => void resume(resultFor)}>
        Let it try again
      </button>
    </div>
  {/if}
</div>

<style>
  /* Same card language as the other bars stacked above the composer (TodoListBar,
     PendingChangesBar): page fill, real border, the composer's corner radius. */
  .s2b-question-bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 22px;
    background: var(--background-primary);
    font-size: var(--font-ui-small);
  }

  .s2b-question-head {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .s2b-question-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-accent);
  }

  .s2b-question-meta {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .s2b-question-dismiss {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 2px;
  }

  .s2b-question-text {
    color: var(--text-normal);
    font-weight: var(--font-medium);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .s2b-question-hint {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  .s2b-question-options {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 40vh;
    overflow-y: auto;
  }

  /* `button.` so the rule outranks Obsidian's own button background and metrics. */
  button.s2b-question-option {
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    gap: 8px;
    width: 100%;
    height: auto;
    padding: 6px 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    background: transparent;
    box-shadow: none;
    color: var(--text-normal);
    font-size: inherit;
    text-align: left;
    white-space: normal;
    cursor: pointer;
  }

  button.s2b-question-option:hover:not(:disabled) {
    background: var(--background-modifier-hover);
  }

  button.s2b-question-option-selected {
    border-color: var(--interactive-accent);
    background: var(--background-modifier-hover);
  }

  .s2b-question-option-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    /* Centres the icon on the label's first line. */
    height: 1.4em;
    color: var(--text-faint);
  }

  .s2b-question-option-selected .s2b-question-option-icon {
    color: var(--interactive-accent);
  }

  .s2b-question-option-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    line-height: 1.4;
  }

  .s2b-question-option-label {
    overflow-wrap: anywhere;
  }

  .s2b-question-option-desc {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    overflow-wrap: anywhere;
  }

  input.s2b-question-custom {
    width: 100%;
    flex-shrink: 0;
  }

  .s2b-question-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
</style>
