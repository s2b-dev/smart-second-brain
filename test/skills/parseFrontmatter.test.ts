/**
 * The one frontmatter parser every skill path shares — discovery, `load_skill`, and the
 * `manage_skills` revision gate — so a CRLF file must parse identically to an LF one. It
 * didn't: values kept a trailing "\r", `name` stopped matching its folder, and the skill
 * vanished from discovery with nothing to say why.
 */

import { describe, expect, it } from "vitest";

import { parseFrontmatter } from "../../src/skills/SkillsService";

const LF = `---
name: weekly-review
description: Run the weekly review
allowed-tools: search_notes read_content
metadata:
  author: "me"
  version: "1.0"
---

# Weekly review

Step one.
`;

describe("parseFrontmatter", () => {
	it("parses a CRLF file the same as an LF one", () => {
		const lf = parseFrontmatter(LF);
		const crlf = parseFrontmatter(LF.replace(/\n/g, "\r\n"));

		expect(crlf.frontmatter).toEqual(lf.frontmatter);
		expect(crlf.frontmatter.name).toBe("weekly-review");
		expect(crlf.frontmatter.metadata?.version).toBe("1.0");
		expect(crlf.body).toBe(lf.body);
	});
});
