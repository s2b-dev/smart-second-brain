import QueryClientProvider from "../../lib/QueryClientProvider.svelte";
import { t } from "../../i18n";
import type SecondBrainPlugin from "../../main";
import { SvelteItemView } from "../SvelteItemView";
import OnboardingComponent from "./Onboarding.svelte";

export const VIEW_TYPE_ONBOARDING = "smart-second-brain-onboarding";

export class OnboardingView extends SvelteItemView {
	getViewType(): string {
		return VIEW_TYPE_ONBOARDING;
	}

	getDisplayText(): string {
		return t("onboarding.view.tab_title");
	}

	getIcon(): string {
		return "zap";
	}

	async onOpen(): Promise<void> {
		// Wrapped in QueryClientProvider because the provider-setup path opened
		// from onboarding relies on TanStack Query (auth validation).
		this.mountComponent(
			QueryClientProvider<{
				plugin: SecondBrainPlugin;
				close: () => void;
			}>,
			{
				plugin: this.plugin,
				component: OnboardingComponent,
				componentProps: {
					plugin: this.plugin,
					close: () => this.leaf.detach(),
				},
			},
			{ containerClass: "s2b-onboarding-container", testId: "onboarding-view" },
		);
	}
}
