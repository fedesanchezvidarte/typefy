import type { DisallowedCharacter } from './characters.js';
import type { CoverImage } from './cover.js';
import { DEFAULT_BUDGET, type PageBudget } from '$lib/chunking/chunker.js';
import { lineCost } from '$lib/chunking/measure.js';

/**
 * The dry-run report (spec #17 §7).
 *
 * Ingestion writes directly to the database, so there is no content diff to review in a pull
 * request. This report is what replaces it: committed next to the manifest entry, read before
 * the book is published, and — because it is in git — the thing that shows a later cleaner
 * change's blast radius across every book at once, as a diff, rather than as a surprise a
 * user finds by typing into it.
 *
 * Pure by construction (`lib-patterns` tier 1): returns the markdown as a string and writes
 * nothing. The script owns the filesystem.
 */

/**
 * The validated cover, as the report presents it (spec #19 §2). `license` and `source` are the
 * manifest's `coverLicense` / `coverSource` — a per-image judgement that is *recorded*, never
 * inferred from the text's licence, and therefore has to be in the artefact being reviewed.
 */
export interface CoverReportEntry {
	image: CoverImage;
	license: string;
	source: string;
}

/** One chapter row as the report presents it (spec #33 §5). */
export interface ChapterReportEntry {
	index: number;
	title: string;
	startChunkIndex: number;
}

export interface ReportInput {
	slug: string;
	title: string;
	sourceUrl: string;
	/** Absent for a book with no cover — which renders no cover line, not an empty one. */
	cover?: CoverReportEntry;
	/** The chunks as they would be written. */
	chunks: readonly string[];
	/** Characters outside the allowed set, from `findDisallowed` over the cleaned text. */
	disallowed: readonly DisallowedCharacter[];
	/** Defaults to the shipped page budget — the same one the chunker just applied. */
	budget?: PageBudget;
	/** Absent when the book declares no chapters config at all (spec #33). */
	chapters?: readonly ChapterReportEntry[];
}

/**
 * A chunk's cost in estimated rendered lines. The report measures pages the way the chunker
 * does — paragraph by paragraph — because the second budget is invisible in a character
 * count: a page of thirty one-word lines is short and still overflows the screen.
 */
function estimatedLines(chunk: string): number {
	let total = 0;
	for (const paragraph of chunk.split('\n')) {
		total += lineCost(paragraph);
	}
	return total;
}

function median(sorted: readonly number[]): number {
	if (sorted.length === 0) return 0;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
		: sorted[middle];
}

/**
 * The chunks quoted in full: the first two and the last two.
 *
 * The ends are where boilerplate survives — a header the start marker missed, a licence
 * paragraph the end marker missed — so they are worth more than a sample from the middle.
 * De-duplicated by index, so a three-chunk book does not print the same chunk twice and read
 * as if it had six.
 */
function quotedChunks(chunks: readonly string[]): { label: string; content: string }[] {
	const indices = new Set<number>();
	for (const index of [0, 1, chunks.length - 2, chunks.length - 1]) {
		if (index >= 0 && index < chunks.length) {
			indices.add(index);
		}
	}
	return [...indices]
		.sort((a, b) => a - b)
		.map((index) => ({ label: `Chunk ${index}`, content: chunks[index] }));
}

/**
 * The cover lines, or none at all. A book with no cover is the intended end state for most of
 * the catalog, not a gap — so it gets silence rather than an empty field to explain.
 */
function coverLines(cover: CoverReportEntry | undefined): string[] {
	if (!cover) {
		return [];
	}
	const { format, width, height, bytes } = cover.image;
	return [
		`- **Cover**: ${format} ${width}x${height}, ${Math.round(bytes / 1024)} KB`,
		`- **Cover licence**: ${cover.license}`,
		`- **Cover source**: ${cover.source}`
	];
}

/** Builds the committed markdown report for one book. */
export function buildReport(input: ReportInput): string {
	const budget = input.budget ?? DEFAULT_BUDGET;
	const lengths = input.chunks.map((chunk) => chunk.length);
	const sorted = [...lengths].sort((a, b) => a - b);
	const total = lengths.reduce((sum, length) => sum + length, 0);
	const lines = input.chunks.map(estimatedLines);
	const sortedLines = [...lines].sort((a, b) => a - b);
	// Over budget, not "outside a target": there is no minimum any more. A short page is a
	// legitimate outcome (a book ends where it ends); only an overrun is worth a look.
	const over = input.chunks.filter(
		(chunk, i) => chunk.length > budget.maxChars || lines[i] > budget.maxLines
	).length;

	const out: string[] = [
		`# Ingestion report — ${input.title}`,
		'',
		'<!-- GENERATED FILE — do not edit by hand. Regenerate with: npm run ingest -- --slug ' +
			`${input.slug} --dry-run -->`,
		'',
		`- **Slug**: \`${input.slug}\``,
		`- **Source**: ${input.sourceUrl}`,
		...coverLines(input.cover),
		'',
		'## Chunks',
		'',
		'| Measure | Value |',
		'|---|---|',
		`| Chunks | ${input.chunks.length} |`,
		`| Total characters | ${total} |`,
		`| Shortest | ${sorted[0] ?? 0} |`,
		`| Median | ${median(sorted)} |`,
		`| Longest | ${sorted[sorted.length - 1] ?? 0} |`,
		`| Median lines | ${median(sortedLines)} |`,
		`| Longest (lines) | ${sortedLines[sortedLines.length - 1] ?? 0} |`,
		`| Over the budget (${budget.maxChars} chars / ${budget.maxLines} lines) | ${over} |`,
		''
	];

	// A page over budget is not automatically wrong — ADR-0005 emits an over-long single
	// sentence whole rather than amputating it — but it is always worth a look.
	if (over > 0) {
		out.push(
			`> ${over} page(s) run past ${budget.maxChars} characters or ${budget.maxLines} estimated`,
			'> lines. That is usually a single sentence emitted whole, which is intended; anything',
			'> else is worth investigating.',
			''
		);
	}

	out.push('## Chapters', '');
	if (input.chapters === undefined) {
		out.push('None declared — this book has no derivable chapter structure.', '');
	} else {
		out.push('| # | Title | Start page | Pages |', '|---|---|---|---|');
		input.chapters.forEach((chapter, i) => {
			const nextStart = input.chapters![i + 1]?.startChunkIndex ?? input.chunks.length;
			const pages = nextStart - chapter.startChunkIndex;
			out.push(
				`| ${chapter.index + 1} | ${chapter.title} | ${chapter.startChunkIndex + 1} | ${pages} |`
			);
		});
		out.push('');
	}

	out.push('## Disallowed characters', '');
	if (input.disallowed.length === 0) {
		out.push('None — every character is in the typeable set.', '');
	} else {
		out.push(
			'**These must be resolved before this book can be ingested.** Each one would make its',
			'passage impossible to complete.',
			'',
			'| Character | Code point | Occurrences | First seen at | Context |',
			'|---|---|---|---|---|'
		);
		for (const entry of input.disallowed) {
			const context = entry.context.replaceAll('|', '\\|');
			out.push(
				`| \`${entry.character}\` | ${entry.codePoint} | ${entry.occurrences} | ${entry.index} | ${context} |`
			);
		}
		out.push('');
	}

	out.push('## Boundary chunks', '', 'The ends are where surviving boilerplate shows up.', '');
	for (const { label, content } of quotedChunks(input.chunks)) {
		out.push(`### ${label}`, '', '```', content, '```', '');
	}

	return out.join('\n');
}
