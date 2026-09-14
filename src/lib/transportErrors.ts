/**
 * Classify transport-level failures of a provider request.
 *
 * Two layers need the same answer. The embedding retry policy
 * (`embedFailedAttempt` in `providers/chatProviders.ts`) must not spend its
 * backoff budget on a host that is not answering, and the bulk indexer
 * (`VectorStoreService`) must stop the run rather than grind every remaining
 * chunk into the same dead connection. Keeping one predicate here means the
 * two agree on what "unreachable" is — they did not before: the indexer matched
 * Node's `ECONNREFUSED` but not the `net::ERR_CONNECTION_REFUSED` Electron's
 * network stack reports through Obsidian's `requestUrl`, so a stopped local
 * server was classified as a per-document failure and retried entry by entry,
 * each entry with six exponential-backoff retries of its own.
 *
 * Error text is read from the error, its `cause` chain (Node's `fetch` wraps
 * the socket error in `TypeError: fetch failed` with the code on `cause`), and
 * any `code` property, so a refused connection is recognised however it was
 * surfaced.
 */

/**
 * Nothing is listening, or the host does not exist. A second attempt cannot
 * succeed until the user starts the server or fixes the address, so callers
 * should stop at once rather than give the connection "one more chance".
 */
const HARD_UNREACHABLE_RE =
	/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_ADDRESS_UNREACHABLE|EHOSTUNREACH|ERR_INTERNET_DISCONNECTED|you are offline/i;

/**
 * The connection failed or never completed, as opposed to the request being
 * rejected. Includes {@link HARD_UNREACHABLE_RE}, timeouts, resets, gateway
 * errors and the generic network-failure phrasings of the fetch
 * implementations in play.
 */
const UNREACHABLE_RE =
	/network error|connection may have changed|fetch failed|failed to fetch|timed out|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET|ERR_NETWORK|ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|socket hang up|\b50[234]\b/i;

/** The strings worth matching on `error`, walking the `cause` chain. */
function errorTexts(error: unknown): string[] {
	const texts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
		if (typeof current !== "object") {
			texts.push(String(current));
			break;
		}
		const { message, code, cause } = current as { message?: unknown; code?: unknown; cause?: unknown };
		if (typeof message === "string") texts.push(message);
		if (typeof code === "string") texts.push(code);
		current = cause;
	}
	return texts;
}

/**
 * The request ran out its timeout. `obsidianFetch` rejects with a
 * `TimeoutError` DOMException; the OpenAI client does not pass that through
 * but throws its own `APIConnectionTimeoutError` ("Request timed out.") with
 * no `cause`, and Electron reports a socket-level one as
 * `ERR_CONNECTION_TIMED_OUT`. All three spellings must match, or an
 * OpenAI-client provider's timeout would still burn the retry budget.
 */
const TIMEOUT_RE = /\btimed? ?out\b|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT/i;

/**
 * True when the request ran out a timeout, however the client reports it.
 * Each such attempt has already waited the full budget (60 s at the fetch
 * level), so retrying it with backoff multiplies minutes.
 */
export function isRequestTimeoutError(error: unknown): boolean {
	return (
		errorNames(error).some((name) => name === "TimeoutError" || name === "APIConnectionTimeoutError") ||
		errorTexts(error).some((text) => TIMEOUT_RE.test(text))
	);
}

function errorName(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const name = (error as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

/** `name` of the error and of everything down its `cause` chain. */
function errorNames(error: unknown): string[] {
	const names: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
		const name = errorName(current);
		if (name) names.push(name);
		current = (current as { cause?: unknown }).cause;
	}
	return names;
}

/**
 * True when the host refused the connection or could not be resolved — the
 * failures where retrying without the user's intervention is pointless.
 */
export function isConnectionRefusedError(error: unknown): boolean {
	return errorTexts(error).some((text) => HARD_UNREACHABLE_RE.test(text));
}

/**
 * True when the error means "the provider is not reachable" rather than
 * "this particular request was rejected". A malformed document, a token-limit
 * rejection or a content filter is specific to one input and worth retrying
 * per entry; a transport failure is a property of the connection and hits
 * every remaining request identically.
 *
 * `AbortError` is deliberately excluded: it means the *user* cancelled, which
 * callers handle first. `TimeoutError` is a provider fault and is included.
 */
export function isProviderUnreachableError(error: unknown): boolean {
	if (errorName(error) === "AbortError") return false;
	if (isRequestTimeoutError(error)) return true;
	if (isConnectionRefusedError(error)) return true;
	return errorTexts(error).some((text) => UNREACHABLE_RE.test(text));
}
