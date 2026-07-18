export type Language = 'en' | 'es';

/** Mirrors the future `books` row + its chunks (ADR-0006), on the typeable-text abstraction. */
export interface TypeableText {
	id: string;
	title: string;
	author: string;
	language: Language; // content language — independent of UI locale
	chunkCount: number;
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
