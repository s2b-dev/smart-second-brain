<script lang="ts">
/**
 * Renders a translated message that has markup in the middle of the sentence: a link, a
 * bold word, inline code. The message names each spot with a `{slot}` token and the caller
 * passes a snippet of the same name, so the translation decides word order and spacing
 * (no space before or after a bold word in Chinese or Japanese, a particle after it in Korean)
 * instead of the template's whitespace deciding it.
 *
 *   <I18nText message={t("onboarding.welcome.search.hotkey")}>
 *     {#snippet link()}<button onclick={open}>{t("onboarding.welcome.search.hotkey_link")}</button>{/snippet}
 *   </I18nText>
 *
 * `t()` leaves a `{name}` token alone when no variable of that name is passed, so slot names
 * must not collide with the message's interpolation variables (use `number`, not `count`).
 */
import type { Snippet } from "svelte";

type Props = { message: string } & { [slot: string]: Snippet | string };

let { message, ...slots }: Props = $props();

const parts = $derived(
	message.split(/(\{\w+\})/).map((text) => {
		const name = /^\{(\w+)\}$/.exec(text)?.[1];
		const snippet = name ? slots[name] : undefined;
		return typeof snippet === "function" ? { snippet } : { text };
	}),
);
</script>

{#each parts as part}{#if part.snippet}{@render part.snippet()}{:else}{part.text}{/if}{/each}
