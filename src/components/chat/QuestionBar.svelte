<script lang="ts">
import type { SessionRegistry } from "../../stores/chatStore.svelte";
import { MessageState } from "../../stores/chatTimeline";
import QuestionForm from "./QuestionForm.svelte";

interface Props {
	registry: SessionRegistry;
	threadPath: string | null;
}

const { registry, threadPath }: Props = $props();
const session = $derived(registry.sessionFor(threadPath));
// The questions the active branch is paused on. They come from the thread's
// checkpoint, so this bar is back after a reload and whenever the branch that
// asked is selected again.
const pending = $derived(session && session.messageState === MessageState.idle ? session.pendingInterrupts : []);
// One form per set of open questions: a new question starts from a clean form.
const formKey = $derived(pending.map((interrupt) => interrupt.id).join("|"));
</script>

{#if session && pending.length > 0}
  {#key formKey}
    <QuestionForm {session} interrupts={pending} />
  {/key}
{/if}
