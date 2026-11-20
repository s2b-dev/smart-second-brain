/**
 * Query-side instruction prefixes for asymmetric embedding models.
 *
 * Several embedding families are trained to encode a *query* differently from a
 * *document*: the query carries a one-sentence task instruction, the documents
 * are embedded raw. Qwen3-Embedding's model card puts it plainly — "in most
 * retrieval scenarios, not using an instruct on the query side can lead to a drop
 * in retrieval performance by approximately 1% to 5%" — and Microsoft's harrier
 * (a Qwen3 fine-tune this repo benchmarks against) answers "is the instruction
 * required?" with "this is how the model is trained, otherwise you will see a
 * performance degradation".
 *
 * Measured on-device, that degradation is not a few percent on short queries. On
 * `openrouter:qwen/qwen3-embedding-4b`, the bare query `history` scored 0.53
 * against a `.chat` thread about what the assistant can do, 0.51 against a stub
 * note reading "Note about a random topic", and 0.40 against `Historical
 * Conspiracies.md`. Content-free text sits near the embedding space's centroid,
 * and so does a one-word query embedded as if it were a document, so every generic
 * note looks like a match and the real answer lands at rank 9. With the
 * instruction the same stored vectors gave `Historical Conspiracies` 0.385,
 * `Ancient Egypt` 0.35, and every chat 0.26-0.33 — the right order, from the same
 * index. Only the query changes, so this needs no reindex.
 *
 * Some families also mark the *document* side (EmbeddingGemma's
 * `title: none | text: `). Those get a `formatDocument`, applied to every chunk
 * at index time. Unlike the query prefix, that one is baked into the stored
 * vectors: an index built before a family gained its document prefix must be
 * rebuilt to benefit (the query and document markers are trained as a pair).
 *
 * Pure module: the family table is keyed on the model id alone so it can be unit
 * tested without a provider, and so a new family is one table row.
 */

/**
 * The task sentence Qwen3-Embedding and harrier ship as their retrieval default.
 * Both cards use this exact wording; keeping it lets their published benchmark
 * numbers stand as the reference for what this repo should see.
 */
export const RETRIEVAL_TASK_INSTRUCTION = "Given a web search query, retrieve relevant passages that answer the query";

interface QueryInstructionFamily {
	/** Human-readable family name, for diagnostics. */
	readonly name: string;
	/** Tested against the lowercased model id (the part after `provider:`). */
	readonly pattern: RegExp;
	/** Wraps a raw query in the family's query-side format. */
	readonly format: (query: string) => string;
	/**
	 * Static prefix for every document chunk at index time, for families trained
	 * with a document-side marker. Absent means documents are embedded raw.
	 */
	readonly documentPrefix?: string;
}

/**
 * Asymmetric families. Most take documents raw and prefix only the query; a
 * family with a document-side marker declares it in `documentPrefix`. Families
 * not listed (plain e5's `passage: `, nomic's `search_document: `) are not yet
 * validated here and pass through raw on both sides.
 */
const FAMILIES: readonly QueryInstructionFamily[] = [
	{
		// Qwen3-Embedding (all sizes, any quantisation suffix), the harrier family
		// built on it, and gte-Qwen2, which uses the identical `Instruct:`/`Query:`
		// template. Model ids vary by host: `qwen/qwen3-embedding-4b` (OpenRouter),
		// `Qwen3-Embedding-4B-4bit-DWQ` (oMLX), `qwen3-embedding:0.6b` (Ollama).
		// The instruct-tuned e5 models (e5-mistral-7b-instruct,
		// multilingual-e5-large-instruct) share the template and, unlike the
		// plain e5 models, take documents raw; their cards state the query
		// instruction is required "otherwise you will see a performance
		// degradation". Plain e5 stays excluded (see above).
		name: "qwen3-instruct",
		pattern: /qwen3-embedding|harrier|gte-qwen|e5-mistral|multilingual-e5-large-instruct/,
		format: (query) => `Instruct: ${RETRIEVAL_TASK_INSTRUCTION}\nQuery: ${query}`,
	},
	{
		// BGE v1/v1.5 English retrievers and mxbai-embed-large: the BAAI card
		// recommends this prefix for short queries against passages; mxbai's card
		// reuses it verbatim. bge-m3 is excluded — its card says no instruction.
		name: "bge-en",
		pattern: /bge-(?:small|base|large)-en|mxbai-embed-large/,
		format: (query) => `Represent this sentence for searching relevant passages: ${query}`,
	},
	{
		// EmbeddingGemma v1 (300m) and v2 (270m text backbone, Gemma 4 based;
		// Ollama `embeddinggemma-2`, which ships the same strings but does NOT
		// apply them). Google's card: retrieval queries are
		// `task: search result | query: {q}`, documents
		// `title: {title | "none"} | text: {content}`, and quality drops without
		// them. Every chunk already starts with the note's title line
		// (`chunkText`), so the title slot stays "none" rather than repeating it.
		name: "embeddinggemma",
		pattern: /embeddinggemma/,
		format: (query) => `task: search result | query: ${query}`,
		documentPrefix: "title: none | text: ",
	},
];

/**
 * Returns the query as the given model expects to receive it for retrieval.
 *
 * Models outside every known family get the query back untouched — the
 * symmetric encoders (OpenAI `text-embedding-3-*`, bge-m3, …) are trained
 * without a query marker and adding one would only shift the vector.
 */
export function formatRetrievalQuery(modelId: string, query: string): string {
	const family = findQueryInstructionFamily(modelId);
	return family ? family.format(query) : query;
}

/**
 * Returns a document chunk as the given model expects to receive it at index
 * time. Raw for every family without a `documentPrefix`.
 */
export function formatRetrievalDocument(modelId: string, text: string): string {
	const prefix = findQueryInstructionFamily(modelId)?.documentPrefix;
	return prefix ? `${prefix}${text}` : text;
}

/** Characters the document prefix adds to each chunk, for the chunk budget. */
export function documentPrefixLength(modelId: string): number {
	return findQueryInstructionFamily(modelId)?.documentPrefix?.length ?? 0;
}

/** Name of the family a model id falls into, or `null` for symmetric models. */
export function queryInstructionFamilyName(modelId: string): string | null {
	return findQueryInstructionFamily(modelId)?.name ?? null;
}

function findQueryInstructionFamily(modelId: string): QueryInstructionFamily | undefined {
	const id = modelId.toLowerCase();
	return FAMILIES.find((family) => family.pattern.test(id));
}
