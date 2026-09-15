<script lang="ts">
import type { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { Notice } from "obsidian";
import { onMount } from "svelte";
import { installObsidianFetch } from "../../lib/obsidianFetch";
import type SecondBrainPlugin from "../../main";
import type { MCPServerConfig } from "../../types/plugin";
import { getData } from "../../stores/dataStore.svelte";
import { Logger } from "../../utils/logging";
import Button from "../ui/Button.svelte";
import CircularLoader from "../ui/CircularLoader.svelte";
import Icon from "../ui/Icon.svelte";
import Text from "../ui/Text.svelte";
import { confirmDelete } from "./ConfirmModal";
import SettingContainer from "../settings/SettingContainer.svelte";
import SettingGroup from "../settings/SettingGroup.svelte";
import TextArea from "../ui/TextArea.svelte";
import type {
	MCPServerAccessors,
	MCPServerModal,
	MCPServerModalCallback,
	MCPServerModalDeleteCallback,
} from "./MCPServerModal";

interface Props {
	modal: MCPServerModal;
	plugin: SecondBrainPlugin;
	serverId: string | null;
	existingConfig: MCPServerConfig | null;
	onSave: MCPServerModalCallback;
	onDelete: MCPServerModalDeleteCallback | null;
	accessors: MCPServerAccessors;
}

const {
	modal,
	plugin,
	serverId: capturedServerId,
	existingConfig: capturedExistingConfig,
	onSave,
	onDelete,
	accessors,
}: Props = $props();

// Capture initial values at component creation (props don't change for modals)
const isEditing = (() => !!capturedServerId && !!capturedExistingConfig)();
const initialConfig = (() => capturedExistingConfig)();

// Generate server ID from name (lowercase, replace spaces/special chars with dashes)
function generateServerId(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Form state - initialized from captured initial values
let name = $state(initialConfig?.displayName ?? "");
// Enabled is deliberately NOT edited here — the server list in the agent editor
// owns that toggle. Carry the existing value through so saving an edit to a
// disabled server doesn't silently re-enable it; new servers start enabled.
const enabled = (() => initialConfig?.enabled ?? true)();

// HTTP is the only transport: a stdio server would spawn a local process, which
// is shell access the plugin deliberately does not ship (see the stdio shim in
// src/lib/shims/). Pasted configs describing one are rejected with a message.
let url = $state(initialConfig?.url ?? "");
let headers = $state(
	Object.entries(initialConfig?.headers ?? {})
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n"),
);

// JSON import. There's no separate import UI: pasting a config snippet into any
// text field is detected and unpacked into the form, the same way the chat
// composer reacts to pasted files rather than hiding them behind a panel.
// Because that silently rewrites fields the user may have already filled, the
// pre-paste values are snapshotted so the banner can offer a one-click undo.
type FormSnapshot = {
	name: string;
	url: string;
	headers: string;
};
let importNotice = $state<string | null>(null);
let importError = $state<string | null>(null);
let importUndo = $state<FormSnapshot | null>(null);

function snapshotForm(): FormSnapshot {
	return { name, url, headers };
}

function restoreForm(snapshot: FormSnapshot) {
	name = snapshot.name;
	url = snapshot.url;
	headers = snapshot.headers;
}

// Connection probe. There is no "Test connection" button: like the provider
// setup modal, the connection is checked automatically whenever the URL or
// headers change, and the verdict lives in the footer next to the actions.
//
// The probe fires when a field is *left* (blur / Enter), not per keystroke: the
// headers may carry a bearer token, and probing every intermediate value while
// a URL is typed would hand that token to whichever host each prefix happens
// to name. `url` is only committed on blur (see the field), and the headers
// the probe sends are the last committed textarea value, `probeHeaders`.
//
// Editing adds one more guard: if the URL now points at a different origin
// than the saved server and there are headers, the probe is held until the
// user asks for it, so credentials stored for host A are never sent to host B
// as a side effect of retyping the URL. Saving, and every agent run after it,
// sends them anyway — that is the user's explicit decision; the hold only
// covers the moment before it.
//
// `probeKey` identifies the config being checked; a result is only shown while
// it still matches, so a stale probe finishing late can never mislabel the
// current form, and a pending probe reads as "checking" rather than as a
// verdict for a config that was never probed.
type DiscoveredTool = { name: string; description?: string };
type ProbeResult = { key: string; ok: boolean; error?: string; tools: DiscoveredTool[] };
type ConnectionStatus = "idle" | "held" | "checking" | "connected" | "failed";

let probe = $state<ProbeResult | null>(null);
// Seeded from the initial headers on purpose (IIFE, as the other captured initial values above).
let probeHeaders = $state((() => headers)());
/** Key of a cross-origin config the user explicitly asked to check anyway. */
let heldKeyReleased = $state<string | null>(null);

function originOf(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}
const savedOrigin = (() => (initialConfig ? originOf(initialConfig.url) : null))();

const probeTarget = $derived.by(() => {
	const trimmed = url.trim();
	return trimmed && originOf(trimmed) !== null ? trimmed : null;
});
const probeKey = $derived(probeTarget === null ? null : `${probeTarget}\n${probeHeaders}`);
const probeHeld = $derived(
	probeKey !== null &&
		probeTarget !== null &&
		savedOrigin !== null &&
		probeHeaders.trim().length > 0 &&
		originOf(probeTarget) !== savedOrigin &&
		heldKeyReleased !== probeKey,
);
const connectionStatus = $derived.by<ConnectionStatus>(() => {
	if (probeKey === null) return "idle";
	if (probeHeld) return "held";
	if (probe?.key !== probeKey) return "checking";
	return probe.ok ? "connected" : "failed";
});
const discoveredTools = $derived(connectionStatus === "connected" && probe ? probe.tools : []);
// Like the provider modal's Done: the confirm button only unlocks once the
// connection has actually validated, so a server can't be saved on a URL that
// was never reached — and a held (cross-origin) probe has to be released first.
// The one exception is an edit that leaves the connection alone (a rename, or
// no change at all): that must stay saveable while the server happens to be
// down, so it is gated on the *saved* config being untouched rather than on a
// live probe of it.
function normalizeHeaders(record: Record<string, string> | undefined): string {
	return JSON.stringify(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}
const connectionUnchanged = $derived(
	initialConfig !== null &&
		url.trim() === initialConfig.url &&
		normalizeHeaders(parseHeaders(headers)) === normalizeHeaders(initialConfig.headers),
);
const canSave = $derived(connectionStatus === "connected" || (isEditing && connectionUnchanged));

$effect(() => {
	const key = probeKey;
	const target = probeTarget;
	const headerText = probeHeaders;
	if (key === null || target === null || probeHeld) return;
	void probeConnection(key, target, headerText);
});

onMount(() => {
	modal.setTitle(isEditing ? `Edit MCP Server: ${capturedExistingConfig?.displayName}` : "Add MCP Server");
});

function parseHeaders(input: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of input.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.includes(":")) continue;
		const colonIndex = trimmed.indexOf(":");
		const key = trimmed.slice(0, colonIndex).trim();
		const value = trimmed.slice(colonIndex + 1).trim();
		if (key) {
			result[key] = value;
		}
	}
	return result;
}

/**
 * Populate the form from a pasted MCP config snippet.
 *
 * Servers publish their setup as a JSON block, but the schema differs by host:
 * Claude Desktop and Cursor nest under `mcpServers`, VS Code under `servers`
 * (or `mcp.servers`) and spells the transport `type` rather than `transport`.
 * A bare single-server object (no wrapper) is accepted too, since that's what
 * people often copy out of a README. Everything is normalised onto our own
 * `MCPServerConfig` shape. Only remote (HTTP/SSE) entries qualify; a local
 * command (stdio) entry is refused with an explanation.
 *
 * This only fills the fields — it doesn't save. The user still reviews and
 * confirms, so a malformed or hostile snippet can't configure a server behind
 * their back.
 */
function applyImportedJson(text: string): string | null {
	const raw = text.trim();
	if (!raw) return "Paste a configuration first";

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return `Invalid JSON: ${err instanceof Error ? err.message : "could not parse"}`;
	}
	if (!parsed || typeof parsed !== "object") {
		return "Configuration must be a JSON object";
	}

	const root = parsed as Record<string, unknown>;
	// Unwrap `{ mcp: { servers: {...} } }` (VS Code settings.json) before
	// looking for the server map.
	const mcpWrapper = root.mcp;
	const scope = (
		mcpWrapper && typeof mcpWrapper === "object" ? (mcpWrapper as Record<string, unknown>) : root
	) as Record<string, unknown>;

	const serverMapCandidate = scope.mcpServers ?? scope.servers;
	let entryKey: string | null = null;
	let entry: Record<string, unknown>;

	if (serverMapCandidate && typeof serverMapCandidate === "object") {
		const entries = Object.entries(serverMapCandidate as Record<string, unknown>).filter(
			([, v]) => v && typeof v === "object",
		);
		if (entries.length === 0) {
			return "No server entries found in the configuration";
		}
		if (entries.length > 1) {
			return "Configuration contains multiple servers — paste one at a time";
		}
		entryKey = entries[0][0];
		entry = entries[0][1] as Record<string, unknown>;
	} else if (typeof scope.url === "string" || typeof scope.command === "string") {
		// Bare single-server object with no wrapper.
		entry = scope;
	} else {
		return "Could not find an MCP server definition (expected an `mcpServers` or `servers` object)";
	}

	// `transport` is ours, `type` is VS Code's; fall back to inferring from
	// whichever of url/command is present.
	const declared = typeof entry.transport === "string" ? entry.transport : entry.type;
	const hasUrl = typeof entry.url === "string" && entry.url.trim().length > 0;
	const hasCommand = typeof entry.command === "string" && entry.command.trim().length > 0;
	// sse is a remote transport we don't model separately; treat it as http so
	// the URL still lands somewhere useful rather than being dropped silently.
	const isStdio = declared === "stdio" || (!declared && !hasUrl && hasCommand);

	if (isStdio) {
		return "This is a local command (stdio) server. Smart Second Brain only connects to MCP servers over HTTP.";
	}
	if (!hasUrl) {
		return "Remote server entry is missing a `url`";
	}

	// Only name an unnamed form — never clobber a name the user already typed.
	// A bare (unwrapped) entry has no key to derive a name from, so the field can
	// legitimately stay empty here; the caller prompts for it rather than letting
	// the user discover it via a validation error on save.
	if (!name.trim()) {
		const displayName = typeof entry.displayName === "string" ? entry.displayName : null;
		name = displayName ?? entryKey ?? "";
	}

	url = (entry.url as string).trim();
	headers = stringifyRecord(entry.headers, ": ");
	probeHeaders = headers;

	return null;
}

/** Render a string-valued record back into the modal's one-per-line textarea format. */
function stringifyRecord(value: unknown, separator: string): string {
	if (!value || typeof value !== "object") return "";
	return Object.entries(value as Record<string, unknown>)
		.filter(([k, v]) => k && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
		.map(([k, v]) => `${k}${separator}${String(v)}`)
		.join("\n");
}

/**
 * Does this pasted text look like a config snippet rather than a field value?
 *
 * Deliberately narrow: only text that starts with `{` and parses as a JSON
 * object qualifies. A URL, a command, a bearer token or a stray brace all fail
 * this and paste through untouched, so the detection can never eat a normal
 * paste. Anything that passes is JSON the user could not have meant as the
 * literal contents of a single field.
 */
function looksLikeConfigJson(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return false;
	try {
		const parsed = JSON.parse(trimmed);
		return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

/**
 * Intercept a paste of a whole config snippet into any field.
 *
 * Returns true when the paste was consumed as an import, in which case the
 * caller prevents the default paste so the raw JSON never lands in the field.
 */
function handleConfigPaste(event: ClipboardEvent): boolean {
	const text = event.clipboardData?.getData("text") ?? "";
	if (!looksLikeConfigJson(text)) return false;

	// It's a config snippet, so it never lands in the field as raw text.
	event.preventDefault();

	// Snapshot before the parse mutates anything, but only commit it as the undo
	// target once the import actually succeeds.
	const before = snapshotForm();
	const error = applyImportedJson(text);
	if (error) {
		// It was JSON, just not a config we understand — say so rather than
		// silently dropping the paste.
		importError = error;
		importNotice = null;
		importUndo = null;
		return true;
	}

	importError = null;
	importUndo = before;
	importNotice = name.trim()
		? "Imported from pasted JSON."
		: "Imported from pasted JSON — enter a name for this server.";
	return true;
}

function undoImport() {
	if (!importUndo) return;
	restoreForm(importUndo);
	importUndo = null;
	importNotice = null;
	importError = null;
}

function validateForm(): string | null {
	if (!name.trim()) {
		return "Name is required";
	}

	const newServerId = generateServerId(name);
	if (!newServerId) {
		return "Name must contain at least one letter or number";
	}

	// Check for duplicate ID (only when creating new or changing name)
	if (!isEditing || newServerId !== capturedServerId) {
		if (accessors.hasServer(newServerId)) {
			return "A server with this name already exists";
		}
	}

	if (!url.trim()) {
		return "URL is required";
	}
	try {
		new URL(url.trim());
	} catch {
		return "Invalid URL format";
	}

	return null;
}

function handleSave() {
	if (!canSave) return;
	const error = validateForm();
	if (error) {
		new Notice(error);
		return;
	}

	const newServerId = generateServerId(name);

	const config: MCPServerConfig = {
		displayName: name.trim(),
		transport: "http",
		enabled,
		url: url.trim(),
		headers: parseHeaders(headers),
	};

	onSave(newServerId, config);
	modal.close();
}

async function handleDelete() {
	if (capturedServerId && capturedExistingConfig && onDelete) {
		if (!(await confirmDelete(plugin.app, capturedExistingConfig.displayName || capturedServerId))) return;
		onDelete(capturedServerId);
		modal.close();
	}
}

/**
 * The adapter wraps transport failures as `Failed to connect to streamable HTTP
 * server "<id>, url: <url>": Error: <cause>` — the id is our internal probe
 * label and the URL is the field right above the status, so only the cause is
 * worth showing.
 */
function describeProbeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const cause = message.replace(/^Failed to connect to [^"]*"[^"]*":\s*/, "").replace(/^Error:\s*/, "");
	return cause.trim() || "Connection failed";
}

/**
 * Probe the server described by `target` + `headerText` and record the verdict
 * under `key`. The result is dropped if the form has moved on by the time it
 * lands (see `probeKey`).
 */
async function probeConnection(key: string, target: string, headerText: string): Promise<void> {
	const config = {
		mcpServers: {
			"probe-server": { transport: "http" as const, url: target, headers: parseHeaders(headerText) },
		},
	};
	let result: ProbeResult;
	try {
		// Ref-counted global-fetch patch for CORS bypass — safe under concurrency
		// (unlike the old _originalFetch flag + finally-restore, which corrupted
		// when two probes overlapped).
		const patch = installObsidianFetch();
		let mcpClient: MultiServerMCPClient | undefined;
		try {
			Logger.debug("Probing MCP connection:", config);
			const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
			mcpClient = new MultiServerMCPClient(config);
			const tools = await mcpClient.getTools();
			result = {
				key,
				ok: true,
				tools: tools.map((t) => ({ name: t.name, description: (t as { description?: string }).description })),
			};
		} finally {
			// Close the client so the open session doesn't dangle after a one-off probe.
			try {
				await mcpClient?.close();
			} catch (closeErr) {
				Logger.debug("MCP client close failed after probe:", closeErr);
			}
			patch.release();
		}
	} catch (err) {
		Logger.debug("MCP connection probe failed:", err);
		result = { key, ok: false, error: describeProbeError(err), tools: [] };
	}
	if (key === probeKey) probe = result;
}
</script>

<!-- Paste is caught here rather than per-input: the event bubbles, so one
     listener covers every field (including ones added later) without threading
     an `onpaste` prop through the shared Text/TextArea primitives. Non-config
     pastes fall through untouched. -->
<div class="mcp-modal-content" onpastecapture={(e) => handleConfigPaste(e)}>
  <!-- Import feedback. Only ever shown as the result of a paste, so the modal
       carries no import affordance of its own when nothing was pasted. -->
  {#if importNotice}
    <div class="mcp-banner success">
      <Icon name="check-circle" />
      <span>{importNotice}</span>
      {#if importUndo}
        <button type="button" class="mcp-banner-action" onclick={undoImport}>Undo</button>
      {/if}
    </div>
  {:else if importError}
    <div class="mcp-banner error">
      <Icon name="alert-circle" />
      <span>{importError}</span>
      <button type="button" class="mcp-banner-action" onclick={() => (importError = null)}>
        Dismiss
      </button>
    </div>
  {/if}

  <!-- One card, one idiom: every field is a native settings row. Wide controls
       (URL, textareas) opt into `mcp-row--stacked`, which drops the control onto
       its own full-width line under the label instead of squeezing it into the
       right-hand column — the reason the old markup reached for ModalField,
       whose larger label weight made those fields read as headings. -->
  <SettingGroup>
    <SettingContainer name="Name" desc="A name for this MCP server">
      <Text
        id="mcp-server-name"
        inputType="text"
        value={name}
        placeholder="My MCP Server"
        onblur={(v) => (name = v)}
      />
    </SettingContainer>

      <!-- Import is advertised in the description rather than with a control:
           ⌘V into any field already does it, so a button would occupy permanent
           space to duplicate a shortcut people reach for by reflex. -->
      <SettingContainer
        class="mcp-row--stacked"
        name="Server URL"
        desc="The URL of the MCP server — or paste the server's JSON config to fill this form"
      >
        <!-- Committed on blur/Enter, not per keystroke — see the probe notes in
             the script for why the connection check must not chase typing. -->
        <Text
          id="mcp-server-url"
          inputType="text"
          value={url}
          placeholder="https://mcp.example.com/mcp"
          onchange={(v) => (url = v)}
          onblur={(v) => (url = v)}
        />
      </SettingContainer>

      <SettingContainer
        class="mcp-row--stacked"
        name="Headers"
        desc="Optional — one per line, Header-Name: value"
      >
        <TextArea
          id="mcp-server-headers"
          class="mcp-textarea"
          bind:value={headers}
          onblur={(v) => (probeHeaders = v)}
          placeholder={"Authorization: Bearer token\nX-Custom-Header: value"}
        />
      </SettingContainer>
  </SettingGroup>

  <!-- Discovered tools. Shown only once the probe connects, so the panel doubles
       as the visible proof that the URL and headers are right. -->
  {#if connectionStatus === "connected" && discoveredTools.length > 0}
    <div class="mcp-tools-panel">
      <div class="mcp-tools-list">
        {#each discoveredTools as tool (tool.name)}
          <div class="mcp-tool-item">
            <span class="mcp-tool-name">{tool.name}</span>
            {#if tool.description}
              <span class="mcp-tool-desc">{tool.description}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Footer. `modal-button-container` is Obsidian's own footer class, so the
       buttons sit where a core modal's do. The connection verdict takes the
       space between Delete and Cancel/Save, the same place the provider setup
       modal reports its status: it is checked automatically, so nothing here
       needs pressing. Delete stays at the left edge, away from the confirm
       button, so a destructive click isn't adjacent to the one people aim for. -->
  <div class="modal-button-container mcp-actions">
    {#if isEditing}
      <Button buttonText="Delete" styles="mod-warning" onClick={handleDelete} />
    {/if}
    <div class="mcp-connection-status" role="status" aria-live="polite">
      {#if connectionStatus === "held"}
        <span class="mcp-connection-icon is-muted"><Icon name="shield-alert" size="xs" /></span>
        <span class="mcp-connection-text is-muted">
          Different host than the saved server — headers are not sent until you
          <button type="button" class="mcp-connection-link" onclick={() => (heldKeyReleased = probeKey)}>
            check now
          </button>
          or save.
        </span>
      {:else if connectionStatus === "checking"}
        <CircularLoader size={16} color="var(--text-muted)" />
        <span class="mcp-connection-text">Checking connection…</span>
      {:else if connectionStatus === "connected"}
        <span class="mcp-connection-icon is-success"><Icon name="check-circle" size="xs" /></span>
        <span class="mcp-connection-text is-success">
          {discoveredTools.length === 0
            ? "Connected — no tools offered"
            : `Connected — ${discoveredTools.length} tool${discoveredTools.length === 1 ? "" : "s"}`}
        </span>
      {:else if connectionStatus === "failed"}
        <span class="mcp-connection-icon is-error"><Icon name="x-circle" size="xs" /></span>
        <span class="mcp-connection-text is-error">{probe?.error ?? "Connection failed"}</span>
      {:else}
        <span class="mcp-connection-text is-muted">Enter the server URL — the connection is checked automatically.</span>
      {/if}
    </div>
    <!-- Kept together so a long status wraps its own text instead of splitting
         the confirm pair onto two lines. -->
    <div class="mcp-actions-primary">
      <Button buttonText="Cancel" onClick={() => modal.close()} />
      <Button buttonText={isEditing ? "Save" : "Add Server"} cta={canSave} disabled={!canSave} onClick={handleSave} />
    </div>
  </div>
</div>

<style>
  .mcp-modal-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
    /* Top only: the modal's own padding already separates the footer from the
       bottom edge, and the flex gap spaces the rows. */
    padding: 8px 0 0;
  }

  /* Import banner. Transient feedback for a paste — colour comes from Obsidian's
     own text vars so it tracks the theme. `color-mix` against a hex keeps the
     tint working in themes that leave the `-hsl` colour vars undefined. */
  .mcp-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--radius-s);
    font-size: var(--font-ui-small);
  }

  .mcp-banner.success {
    background: color-mix(in srgb, var(--text-success, #4caf50) 12%, transparent);
    color: var(--text-success, #4caf50);
  }

  .mcp-banner.error {
    background: color-mix(in srgb, var(--text-error, #f44336) 12%, transparent);
    color: var(--text-error, #f44336);
  }

  .mcp-banner span {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* Inline text action — deliberately not a Button: it sits inside coloured
     text and should inherit that colour rather than render as a control. */
  .mcp-banner-action {
    flex: 0 0 auto;
    padding: 2px 6px;
    border: none;
    box-shadow: none;
    background: transparent;
    color: inherit;
    font-size: var(--font-ui-smaller);
    font-weight: 600;
    text-decoration: underline;
    cursor: pointer;
  }

  .mcp-banner-action:hover {
    background: var(--background-modifier-hover);
  }

  /* Wide-control settings row: keep the native label/description column, but let
     the control take the full width on its own line beneath it. Obsidian already
     does exactly this on phones; this opts specific desktop rows into the same
     shape so a URL or textarea isn't crushed into the right-hand column. */
  :global(.mcp-row--stacked) {
    display: block;
  }

  /* Fully global: `.setting-item-control` belongs to SettingContainer's scope,
     so a scoped descendant selector here would never match it. */
  :global(.mcp-row--stacked .setting-item-control) {
    width: 100%;
    justify-content: flex-start;
    margin-top: 8px;
    padding-top: 0;
  }

  /* Inputs default to their intrinsic width, which is what truncated the URL. */
  :global(.mcp-row--stacked .setting-item-control input[type="text"]) {
    width: 100%;
  }

  :global(.mcp-textarea) {
    width: 100%;
    min-height: 80px;
    padding: 8px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-secondary);
    color: var(--text-normal);
    font-family: var(--font-monospace);
    font-size: 0.9rem;
    resize: vertical;
  }

  :global(.mcp-textarea):focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: 0 0 0 1px var(--interactive-accent);
  }

  /* `modal-button-container` supplies the border, padding and spacing; this only
     adds what it doesn't: a flex row so the status can fill the middle and push
     Cancel/Save right while Delete stays left, and wrapping for narrow panes. */
  .mcp-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    /* Core gives the footer a large top margin for modals whose body sits flush
       against it; here the flex gap already provides the spacing, so the two
       stacked and left a visible hole between "Test connection" and the buttons. */
    margin-top: 0;
  }

  /* Phone: core stacks `.modal-button-container` into a column; the row-oriented
     `align-items: center` above would shrink each button to its label width.
     Stretch restores the native full-width stacked footer buttons. */
  :global(.is-phone) .mcp-actions {
    align-items: stretch;
  }

  :global(.is-phone) .mcp-actions-primary {
    flex-direction: column;
    align-items: stretch;
  }

  /* Connection verdict in the footer — mirrors `.provider-connection-status`
     in the provider setup modal. Takes the free space between the button
     groups and wraps long error messages instead of pushing the buttons out. */
  .mcp-connection-status {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    /* Zero basis: the status takes whatever is left and wraps its text, rather
       than claiming its content width and forcing the buttons onto a new line. */
    flex: 1 1 0;
    min-width: 0;
  }

  .mcp-actions-primary {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  /* Inline "check now" inside the held-status sentence: reads as a link, not a control. */
  .mcp-connection-link {
    display: inline;
    padding: 0;
    border: none;
    box-shadow: none;
    background: transparent;
    color: var(--text-accent);
    font-size: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .mcp-connection-link:hover {
    color: var(--text-accent-hover);
    background: transparent;
  }

  .mcp-connection-icon {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .mcp-connection-icon.is-muted {
    color: var(--text-muted);
  }

  .mcp-connection-text {
    font-size: var(--font-ui-small);
    overflow-wrap: anywhere;
  }

  .mcp-connection-text.is-muted {
    color: var(--text-muted);
  }

  .is-success {
    color: var(--text-success, #4caf50);
  }

  .mcp-connection-text.is-success {
    font-weight: 500;
  }

  .is-error {
    color: var(--text-error, #f44336);
  }

  .mcp-tools-panel {
    padding: 12px;
    border-radius: 6px;
    border: 1px solid var(--background-modifier-border);
  }

  .mcp-tools-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 200px;
    overflow-y: auto;
  }

  .mcp-tool-item {
    display: flex;
    flex-direction: column;
    padding: 8px;
    background: var(--background-secondary);
    border-radius: 4px;
  }

  .mcp-tool-name {
    font-weight: 500;
    font-family: var(--font-monospace);
    font-size: 0.9rem;
  }

  .mcp-tool-desc {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 2px;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
