import { getLanguage } from "obsidian";
import { addMessages, init } from "svelte-i18n";

import en from "./en.json";

addMessages("en", en);

void init({
	fallbackLocale: "en",
	initialLocale: getLanguage(),
});
