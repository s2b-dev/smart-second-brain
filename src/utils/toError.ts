/**
 * Coerce an arbitrary rejection reason into an `Error`.
 *
 * IndexedDB reports failures as `request.error` / `tx.error`, typed
 * `DOMException | null`, and `catch` clauses receive `unknown`; promise
 * consumers expect a real `Error` so stacks and messages survive. A `null`
 * or non-Error reason becomes an `Error` carrying `fallbackMessage`.
 */
export function toError(reason: unknown, fallbackMessage = "Unknown error"): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string" && reason.length > 0) return new Error(reason);
	return new Error(fallbackMessage);
}
