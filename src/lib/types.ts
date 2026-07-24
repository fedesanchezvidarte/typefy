export type Language = 'en' | 'es';

/**
 * Book metadata without chunk content — what the `/type` picker needs (spec #7:
 * the book list loads metadata only, no chunk text). `id` is the book's slug.
 */
export interface TypeableTextSummary {
	id: string; // the book's slug; used as the /type/[slug] URL segment
	title: string;
	author: string;
	language: Language; // content language — independent of UI locale
	chunkCount: number;
}

/** A summary plus its chunks (ADR-0006 `books` row + its `chunks`). */
export interface TypeableText extends TypeableTextSummary {
	chunks: readonly Chunk[];
}

/** Mirrors the future `chunks` row. `textId` maps to `book_id` in Phase 2. */
export interface Chunk {
	id: string;
	textId: string;
	index: number; // 0-based order within the text
	content: string; // 400-600 chars, hand-chunked per ADR-0005
	charCount: number;
}
