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

/**
 * The Open Library lookup, as the report presents it (spec #34).
 *
 * Present on every ingest — including when nothing was declared and when the lookup failed —
 * because the failure is deliberately **non-fatal**, and a non-fatal failure that appears
 * nowhere is a year that quietly turns blank between one ingest and the next.
 */
export interface MetadataReportEntry {
	/** The manifest's declared work id. Absent → nothing was declared, which is not a failure. */
	work?: string;
	/** The year actually written to the catalog — the manifest's when declared, else the fetched one. */
	year: number | null;
	/**
	 * What Open Library's `first_publish_year` produced. Absent when no lookup was attempted;
	 * `null` when one was and yielded nothing. Kept separate from `year` so the report can
	 * attribute the number rather than presenting two sources as one anonymous fact.
	 */
	openLibraryYear?: number | null;
	/** The manifest's declared year, when it declared one. Wins over `openLibraryYear`. */
	manifestYear?: number;
	/** Open Library's description — what would be stored under the `default` summary key. */
	description: string | null;
	/**
	 * The manifest's hand-written blurbs, keyed by UI locale (spec #55).
	 *
	 * The TEXT, not just the locale keys the earlier report listed: since every book is now
	 * required to declare every locale, a list of keys is the same two words on all 17 reports
	 * and says nothing. What a reviewer needs is the length and the opening of each blurb — the
	 * same pair the `description` row and block already give Open Library's.
	 */
	summaries?: Readonly<Record<string, string>>;
	/** The reason the lookup produced nothing usable. Never fatal; always reported. */
	failure?: string;
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
	/** The Open Library lookup and any manifest overrides (spec #34). */
	metadata?: MetadataReportEntry;
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

/**
 * How much of a summary the report quotes — Open Library's `default` and the manifest's
 * hand-written blurbs alike. One constant deliberately: the two sit in the same section and a
 * reviewer comparing them should not be comparing extracts of different lengths.
 */
const DESCRIPTION_PREVIEW = 200;

/** The opening of `text`, marked with `…` when there is more of it. */
function preview(text: string): string {
	const opening = text.slice(0, DESCRIPTION_PREVIEW);
	return text.length > DESCRIPTION_PREVIEW ? `${opening}…` : opening;
}

/**
 * The year, with **where it came from** (spec #34).
 *
 * A bare number cannot be reviewed: the whole point of the manifest override is that Open
 * Library's `first_publish_year` is the earliest *catalogued edition*, so "1600" for Don
 * Quijote is not a typo to fix but a different fact wearing the same name. The reader has to
 * be able to tell a hand-declared year from a fetched one, and above all has to be TOLD when
 * the two disagree — that disagreement is the reason this override exists, and it is the one
 * thing in this section worth a human's attention.
 *
 * Agreement is reported too, and is not noise: it says the override has become redundant
 * because Open Library caught up, which is a reason to delete a line from the manifest.
 */
function yearCell(metadata: MetadataReportEntry): string {
	const { year, manifestYear, openLibraryYear } = metadata;

	if (year === null) {
		return 'None';
	}
	if (manifestYear === undefined) {
		return `${year} (Open Library)`;
	}
	// A declared year with nothing to compare against — no lookup, or one that failed. It must
	// not read as an "override", because there is nothing it overrode.
	if (openLibraryYear === undefined || openLibraryYear === null) {
		return `${year} (manifest)`;
	}
	if (openLibraryYear === manifestYear) {
		return `${year} (manifest, agrees with Open Library)`;
	}
	return `${year} (manifest override; Open Library says ${openLibraryYear})`;
}

/**
 * The `## Metadata` section (spec #34).
 *
 * The description is reported by **length plus its opening**, never in full: a report is a
 * review artefact, and a multi-paragraph blurb pasted whole would drown the sections that
 * actually need reading. The length is what makes a silently truncated or swapped description
 * visible in a diff; the opening is what makes it recognisable.
 */
function metadataLines(metadata: MetadataReportEntry | undefined): string[] {
	const summaries = metadata?.summaries ?? {};
	const locales = Object.keys(summaries).sort();

	// "Nothing declared" is not a failure and must not read as one. Since spec #55 no CATALOG
	// book can reach this branch — a manifest entry without both blurbs is refused before the
	// ingest runs — but it still describes a manifest the validator was not run against, and
	// deleting it would trade a correct sentence for nothing.
	if (
		!metadata ||
		(metadata.work === undefined && locales.length === 0 && metadata.manifestYear === undefined)
	) {
		return ['## Metadata', '', 'None declared — this book ships without a year or a summary.', ''];
	}

	const description = metadata.description;
	const out = [
		'## Metadata',
		'',
		'| Field | Value |',
		'|---|---|',
		`| Open Library work | ${metadata.work ? `\`${metadata.work}\`` : 'None declared'} |`,
		`| First publication year | ${yearCell(metadata)} |`,
		// One row per locale, length only — the opening goes in its own block below, the way the
		// description's already does. Two 600-character blurbs inside table cells is a table
		// nobody reads.
		...(locales.length > 0
			? locales.map(
					(locale) =>
						`| Summary (\`${locale}\`) | ${summaries[locale].length} characters (manifest) |`
				)
			: ['| Summary | None declared |']),
		`| Description | ${
			description ? `${description.length} characters, from Open Library` : 'None'
		} |`,
		''
	];

	// The two sources disagreeing is not an error — it is the single fact in this section a
	// reviewer should stop on, so it gets its own blockquote rather than living inside a table
	// cell. Either the manifest is right and this is the override doing its job, or the
	// manifest is stale and wants correcting; the report cannot know which, so it says both.
	if (
		metadata.manifestYear !== undefined &&
		typeof metadata.openLibraryYear === 'number' &&
		metadata.openLibraryYear !== metadata.manifestYear
	) {
		out.push(
			`> The sources disagree: the manifest declares ${metadata.manifestYear}, Open Library ` +
				`reports ${metadata.openLibraryYear}.`,
			`> The manifest wins, so ${metadata.manifestYear} is what gets written. Open Library reports the`,
			'> earliest edition it has CATALOGUED, which is not the same fact as first publication —',
			'> confirm the declared year is still the better one before publishing.',
			''
		);
	}

	// A failure is non-fatal, so this blockquote is the only place a reviewer meets it in the
	// committed diff. Same shape as the over-budget warning above, deliberately: one thing to
	// learn to read, not two.
	if (metadata.failure) {
		out.push(
			`> Open Library lookup failed: ${metadata.failure}`,
			'> This book is ingested without a year and without a `default` summary; any manifest',
			'> override is unaffected. Re-run the ingest once the lookup works to restore them.',
			''
		);
	}

	// The hand-written blurbs come FIRST, before Open Library's description, because they are
	// what every reader actually sees: a locale key always wins, and since spec #55 every locale
	// has one. `default` is now a fallback for a state the validator refuses to allow, and a
	// report that led with it would rank the sources the wrong way round.
	for (const locale of locales) {
		out.push(`Opening of the \`${locale}\` summary, as declared in the manifest:`, '', '```');
		out.push(preview(summaries[locale]), '```', '');
	}

	if (description) {
		out.push(
			'Opening of the description, as it would be stored under `default`:',
			'',
			'```',
			preview(description),
			'```',
			''
		);
	}

	return out;
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

	out.push(...metadataLines(input.metadata));

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
