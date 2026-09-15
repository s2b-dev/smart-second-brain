export enum LogLvl {
	DEBUG = 1,
	INFO = 2,
	WARN = 3,
	ERROR = 4,
	DISABLED = 5,
}

let logLevel = LogLvl.DEBUG;

/** Current log level. Exposed so other modules (e.g. the startup profiler) can gate work. */
export function getLogLevel(): LogLvl {
	return logLevel;
}

/**
 * Apply the "Developer Console logging" (verbose) preference to the Logger.
 * Verbose on → DEBUG (everything). Verbose off → WARN (warnings + errors only),
 * so the console isn't flooded during normal use.
 */
export function applyVerboseLogging(verbose: boolean): void {
	logLevel = verbose ? LogLvl.DEBUG : LogLvl.WARN;
}

export const Logger = {
	setLogLevel(level: LogLvl) {
		logLevel = level;
	},

	debug(...args: unknown[]) {
		if (logLevel <= LogLvl.DEBUG) console.debug("[S2B]", ...args);
	},

	// INFO-level output also goes through `console.debug`: Obsidian's plugin
	// guidelines reserve the console's default (non-verbose) level for warnings
	// and errors, so routine progress lines must not surface there.
	log(...args: unknown[]) {
		if (logLevel <= LogLvl.INFO) console.debug("[S2B]", ...args);
	},

	info(...args: unknown[]) {
		if (logLevel <= LogLvl.INFO) console.debug("[S2B]", ...args);
	},

	warn(...args: unknown[]) {
		if (logLevel <= LogLvl.WARN) console.warn("[S2B]", ...args);
	},

	error(...args: unknown[]) {
		if (logLevel <= LogLvl.ERROR) console.error("[S2B]", ...args);
	},
};
