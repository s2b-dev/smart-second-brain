import { tool } from "@langchain/core/tools";
import { htmlToMarkdown } from "obsidian";
import { z } from "zod";
import { createObsidianFetch } from "../../lib/obsidianFetch";
import { getData } from "../../stores/dataStore.svelte";
import { Logger } from "../../utils/logging";
import { READ_CONTENT_BUDGET_FRACTION, contextWindowToCharBudget } from "../../utils/contentBudget";

const FETCH_TIMEOUT_MS = 20_000;
/** Hard ceiling on raw response size we will read (binary or text), independent of the post-strip cap. */
const MAX_RAW_BYTES = 4 * 1024 * 1024;
/** Maximum redirect hops we will follow before giving up. */
const MAX_REDIRECTS = 5;

/** Tags whose contents are pure noise once converted to markdown. */
const NOISE_TAG_PATTERN = /<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** Self-closing or empty noise tags (rare but possible: `<style />`). */
const SELF_CLOSING_NOISE_PATTERN = /<(script|style|noscript|svg|template|iframe)\b[^>]*\/>/gi;
/** HTML comments. */
const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
/** Layout chrome that htmlToMarkdown otherwise preserves verbatim. */
const CHROME_TAG_PATTERN = /<(nav|footer|aside|header|form)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Hostnames that unambiguously point at the local machine regardless of resolver behavior. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

function isHtmlContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const lower = contentType.toLowerCase();
	return lower.includes("text/html") || lower.includes("application/xhtml");
}

function isTextualContentType(contentType: string | null): boolean {
	if (!contentType) return true; // be lenient — many servers omit it
	const lower = contentType.toLowerCase();
	return (
		lower.startsWith("text/") ||
		lower.includes("json") ||
		lower.includes("xml") ||
		lower.includes("javascript") ||
		lower.includes("yaml")
	);
}

/**
 * Best-effort check for private / loopback / link-local IP addresses.
 * We deliberately reject on hostname text alone rather than DNS resolution —
 * we cannot safely resolve from the browser environment, and rejecting suspicious
 * hostnames is the conservative choice. Redirects to public hostnames whose DNS
 * points at private ranges will still slip through; this only blocks the obvious
 * attack surface (literal IPs and known-local names).
 */
function isPrivateOrLocalHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

	if (LOOPBACK_HOSTNAMES.has(host)) return true;
	if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;

	// IPv4 literal
	const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const octets = ipv4.slice(1, 5).map((s) => Number.parseInt(s, 10));
		if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return true; // malformed → reject
		const [a, b] = octets;
		// 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
		if (a === 0 || a === 10 || a === 127) return true;
		// 100.64.0.0/10 (CGNAT)
		if (a === 100 && b >= 64 && b <= 127) return true;
		// 169.254.0.0/16 (link-local, includes cloud metadata endpoints)
		if (a === 169 && b === 254) return true;
		// 172.16.0.0/12
		if (a === 172 && b >= 16 && b <= 31) return true;
		// 192.168.0.0/16, 192.0.0.0/24 (IETF), 192.0.2.0/24 (TEST-NET-1)
		if (a === 192 && (b === 168 || b === 0)) return true;
		// 198.18.0.0/15 (benchmarking), 198.51.100.0/24 (TEST-NET-2)
		if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
		// 203.0.113.0/24 (TEST-NET-3)
		if (a === 203 && b === 0) return true;
		// 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved)
		if (a >= 224) return true;
		return false;
	}

	// IPv6 literal — reject loopback, link-local, unique-local, and IPv4-mapped ranges.
	// This is not a full parser; it flags the well-known prefixes.
	if (host.includes(":")) {
		if (host === "::" || host === "::1") return true;
		if (host.startsWith("fe80:") || host.startsWith("fe80::")) return true; // link-local
		if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique-local fc00::/7
		if (host.startsWith("ff")) return true; // multicast ff00::/8
		if (host.startsWith("::ffff:")) {
			// IPv4-mapped IPv6 — extract the embedded IPv4 and re-check
			const embedded = host.slice(7);
			if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(embedded)) {
				return isPrivateOrLocalHostname(embedded);
			}
		}
	}

	return false;
}

/** Validate a URL and enforce scheme + private-network policy. Returns an error string or null. */
function validateUrl(target: URL): string | null {
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		return `Unsupported protocol "${target.protocol}". Only http(s) URLs are allowed.`;
	}
	if (isPrivateOrLocalHostname(target.hostname)) {
		return `Refusing to fetch "${target.href}" — target resolves to a private, loopback, or link-local address.`;
	}
	return null;
}

/**
 * Strip script/style/nav/footer/aside/header/form/comments from raw HTML before
 * handing it to Obsidian's htmlToMarkdown. We do this with regex rather than
 * DOMParser because htmlToMarkdown will re-parse the cleaned string itself.
 */
function preStripHtml(html: string): string {
	return html
		.replace(COMMENT_PATTERN, "")
		.replace(NOISE_TAG_PATTERN, "")
		.replace(SELF_CLOSING_NOISE_PATTERN, "")
		.replace(CHROME_TAG_PATTERN, "");
}

/**
 * Collapse runs of 3+ blank lines that htmlToMarkdown sometimes produces from
 * stripped chrome, without touching code blocks (no fenced-block awareness here
 * is fine — htmlToMarkdown emits 4-space-indented code, not fences).
 */
function tidyMarkdown(md: string): string {
	return md.replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(content: string, maxChars: number): string {
	if (maxChars <= 0 || content.length <= maxChars) return content;
	return `${content.slice(0, maxChars)}\n\n[...truncated ${content.length - maxChars} characters to fit context limits...]`;
}

/**
 * Read a response body into a Uint8Array, aborting once the running byte count
 * exceeds `maxBytes`. On the streaming path this avoids allocating a huge
 * buffer for oversized responses. Falls back to `arrayBuffer()` when the body
 * isn't a stream (e.g., Obsidian's requestUrl transport materializes the
 * whole response before we see it — the caller must still check size after).
 */
async function readBoundedBody(
	response: Response,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
	const reader = response.body?.getReader?.();
	if (!reader) {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBytes) return { bytes: new Uint8Array(0), overflow: true };
		return { bytes: new Uint8Array(buffer), overflow: false };
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				return { bytes: new Uint8Array(0), overflow: true };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock?.();
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return { bytes: merged, overflow: false };
}

/**
 * Tool for fetching a URL and returning a cleaned markdown view of its content.
 * Uses Obsidian's htmlToMarkdown after stripping boilerplate so layout (headings,
 * lists, tables, links) is preserved while scripts/styles/nav chrome are removed.
 *
 * Routes through createObsidianFetch so CORS-restricted hosts fall back to
 * Obsidian's requestUrl, mirroring how the rest of the plugin reaches the network.
 * Because requestUrl bypasses browser CORS/PNA protections, we validate the URL
 * scheme AND reject private-network targets ourselves — and re-validate each hop
 * when following redirects manually.
 */
export function createFetchUrlTool() {
	const pluginData = getData();
	const getToolConfig = () => pluginData.getSelectedAgent().toolsConfig.fetch_url;
	const fetchImpl = createObsidianFetch(window.fetch.bind(window));

	const fetchUrlFn = async ({ url }: { url: string }): Promise<string> => {
		const trimmed = url?.trim();
		if (!trimmed) return "Error: URL is empty.";

		let currentUrl: URL;
		try {
			currentUrl = new URL(trimmed);
		} catch {
			return `Error: "${url}" is not a valid URL. Include the scheme (https://...).`;
		}

		const initialError = validateUrl(currentUrl);
		if (initialError) return `Error: ${initialError}`;

		const contextWindow = pluginData.getSelectedAgent().chatModel?.modelConfig?.contextWindow;
		const maxContentLength = contextWindowToCharBudget(contextWindow, READ_CONTENT_BUDGET_FRACTION);

		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		try {
			// Follow redirects manually so we can re-validate each hop's target
			// against the private-network policy.
			let response: Response | null = null;
			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				Logger.log(`[fetch_url] Fetching ${currentUrl.href}${hop > 0 ? ` (hop ${hop})` : ""}`);
				response = await fetchImpl(currentUrl.href, {
					method: "GET",
					headers: {
						Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
						"Accept-Language": "en-US,en;q=0.9",
					},
					signal: controller.signal,
					redirect: "manual",
				});

				const status = response.status;
				const isRedirect = status >= 300 && status < 400 && status !== 304;
				if (!isRedirect) break;

				const location = response.headers.get("location");
				if (!location) break; // Malformed redirect — treat the response as-is
				let nextUrl: URL;
				try {
					nextUrl = new URL(location, currentUrl);
				} catch {
					return `Error: Redirect from "${currentUrl.href}" pointed at an invalid Location "${location}".`;
				}
				const hopError = validateUrl(nextUrl);
				if (hopError) return `Error: ${hopError}`;
				currentUrl = nextUrl;
				if (hop === MAX_REDIRECTS) {
					return `Error: Too many redirects (>${MAX_REDIRECTS}) starting from "${trimmed}".`;
				}
			}
			if (!response) return `Error: No response received from "${currentUrl.href}".`;

			if (!response.ok) {
				return `Error: HTTP ${response.status} ${response.statusText} fetching "${currentUrl.href}".`;
			}

			const contentType = response.headers.get("content-type");
			if (!isTextualContentType(contentType)) {
				return `Error: "${currentUrl.href}" returned non-textual content (${contentType ?? "unknown content type"}). This tool only handles text-based responses.`;
			}

			const { bytes, overflow } = await readBoundedBody(response, MAX_RAW_BYTES);
			if (overflow) {
				return `Error: Response body for "${currentUrl.href}" exceeds ${MAX_RAW_BYTES} bytes. Refusing to load.`;
			}
			const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

			let body: string;
			let format: "markdown" | "text";
			if (isHtmlContentType(contentType) || /<\s*html[\s>]/i.test(raw.slice(0, 2048))) {
				const cleaned = preStripHtml(raw);
				body = tidyMarkdown(htmlToMarkdown(cleaned));
				format = "markdown";
			} else {
				body = raw.trim();
				format = "text";
			}

			if (!body) {
				return `Fetched "${currentUrl.href}" but the response had no readable content after cleaning.`;
			}

			const output = truncate(body, maxContentLength);
			const header = `Content of "${currentUrl.href}" (${format}, ${output.length} chars):`;
			return `${header}\n\n${output}`;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				return `Error: Request to "${currentUrl.href}" timed out after ${FETCH_TIMEOUT_MS}ms.`;
			}
			const message = error instanceof Error ? error.message : String(error);
			Logger.error(`[fetch_url] Failed to fetch ${currentUrl.href}`, error);
			return `Error fetching "${currentUrl.href}": ${message}`;
		} finally {
			window.clearTimeout(timeout);
		}
	};

	const toolConfig = getToolConfig();

	return tool(fetchUrlFn, {
		name: toolConfig?.name ?? "fetch_url",
		description:
			toolConfig?.description ??
			"Fetch a public web page or text resource over HTTP(S) and return its main content. HTML is converted to markdown with scripts, styles, and navigation chrome removed while headings, lists, tables, code blocks, and links are preserved. JSON, plain text, and other text-based responses are returned as-is. Requests to local, private, or link-local addresses are rejected. Use this when the user asks about a specific URL or when external information is needed that the vault does not contain.",
		schema: z.object({
			url: z
				.string()
				.describe(
					"Absolute http(s) URL to fetch (e.g., 'https://example.com/article'). Relative paths, other schemes, and private-network addresses are rejected.",
				),
		}),
	});
}
