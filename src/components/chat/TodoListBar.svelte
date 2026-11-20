<script lang="ts">
import type { SessionRegistry } from "../../stores/chatStore.svelte";
import { MessageState } from "../../stores/chatTimeline";
import { latestTodos, shouldShowTodos, type TodoStatus } from "../../utils/todoList";
import { icon } from "../../utils/utils";
import { t } from "../../i18n";

interface Props {
	registry: SessionRegistry;
	threadPath: string | null;
}

const { registry, threadPath }: Props = $props();
const session = $derived(registry.sessionFor(threadPath));
const messages = $derived(session?.messages ?? []);
const snapshot = $derived(latestTodos(messages));
const visible = $derived(shouldShowTodos(snapshot, messages.length));
const running = $derived(session?.messageState === MessageState.answering);

const todos = $derived(snapshot?.todos ?? []);
const doneCount = $derived(todos.filter((todo) => todo.status === "completed").length);
const current = $derived(todos.find((todo) => todo.status === "in_progress"));
const allDone = $derived(todos.length > 0 && doneCount === todos.length);
/** What the collapsed row names: the step in progress, else the next one still open. */
const headline = $derived(
	allDone ? t("chat.todos.all_done") : ((current ?? todos.find((todo) => todo.status === "pending"))?.content ?? ""),
);

let isExpanded = $state(false);

const STATUS_ICON: Record<TodoStatus, string> = {
	pending: "circle",
	in_progress: "circle-dot",
	completed: "circle-check",
};
const STATUS_LABEL: Record<TodoStatus, string> = {
	pending: t("chat.todos.status_pending"),
	in_progress: t("chat.todos.status_in_progress"),
	completed: t("common.done"),
};
</script>

{#if visible}
  <div class="s2b-todo-bar">
    <button
      class="s2b-todo-summary"
      type="button"
      aria-expanded={isExpanded}
      aria-label={isExpanded ? t("chat.todos.collapse") : t("chat.todos.expand")}
      onclick={() => (isExpanded = !isExpanded)}
    >
      <div
        class="s2b-todo-icon"
        class:s2b-todo-icon-running={running && !allDone}
        use:icon={allDone ? "list-checks" : "list-todo"}
        style="--icon-size: var(--icon-xs)"
      ></div>
      <span class="s2b-todo-count">{t("chat.todos.progress", { done: doneCount, total: todos.length })}</span>
      <span class="s2b-todo-headline">{headline}</span>
      <div
        class="s2b-todo-chevron"
        use:icon={isExpanded ? "chevron-down" : "chevron-up"}
        style="--icon-size: var(--icon-xs)"
      ></div>
    </button>
    {#if isExpanded}
      <ol class="s2b-todo-list">
        {#each todos as todo, i (i)}
          <li class="s2b-todo-item" data-status={todo.status}>
            <div
              class="s2b-todo-item-icon"
              use:icon={STATUS_ICON[todo.status]}
              style="--icon-size: var(--icon-xs)"
              aria-label={STATUS_LABEL[todo.status]}
            ></div>
            <span class="s2b-todo-item-text">{todo.content}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
{/if}

<style>
  /* Same card language as PendingChangesBar, which it stacks with above the composer:
     page fill, real border, the composer's 22px pill. */
  .s2b-todo-bar {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--background-modifier-border);
    border-radius: 22px;
    overflow: hidden;
    background: var(--background-primary);
  }

  .s2b-todo-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    width: 100%;
    height: auto;
    padding: 6px 12px;
    background: transparent;
    border: none;
    box-shadow: none;
    border-radius: 0;
    cursor: pointer;
    color: var(--text-normal);
    font-size: var(--font-ui-smaller);
    text-align: left;
  }

  .s2b-todo-summary:hover {
    background: var(--background-modifier-hover);
  }

  .s2b-todo-icon,
  .s2b-todo-chevron,
  .s2b-todo-item-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .s2b-todo-icon {
    color: var(--text-accent);
  }

  .s2b-todo-icon-running {
    animation: s2b-todo-pulse 1.6s ease-in-out infinite;
  }

  .s2b-todo-count {
    flex-shrink: 0;
    font-weight: var(--font-medium);
  }

  .s2b-todo-headline {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }

  .s2b-todo-chevron {
    color: var(--text-faint);
  }

  .s2b-todo-list {
    list-style: none;
    margin: 0;
    padding: 2px 12px 8px;
    max-height: 30vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--font-ui-smaller);
  }

  .s2b-todo-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    color: var(--text-normal);
  }

  .s2b-todo-item-icon {
    /* Centres the icon on the first line of a wrapped step. */
    height: 1.4em;
    color: var(--text-faint);
  }

  .s2b-todo-item-text {
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .s2b-todo-item[data-status="in_progress"] .s2b-todo-item-icon {
    color: var(--text-accent);
  }

  .s2b-todo-item[data-status="in_progress"] .s2b-todo-item-text {
    font-weight: var(--font-medium);
  }

  .s2b-todo-item[data-status="completed"] .s2b-todo-item-icon {
    color: var(--color-green);
  }

  .s2b-todo-item[data-status="completed"] .s2b-todo-item-text {
    color: var(--text-muted);
    text-decoration: line-through;
  }

  @keyframes s2b-todo-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .s2b-todo-icon-running {
      animation: none;
    }
  }
</style>
