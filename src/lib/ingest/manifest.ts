import type { CleaningOverrides } from './clean.js';
import type { Language, Locale } from '$lib/types';

/**
 * The book manifest: parsing and validation (spec #17 §2).
 *
 * The manifest is the committed source of truth for *which* books the catalog contains and
 * their metadata. Ingestion reads it and never invents metadata — Gutenberg's header formats
 * vary by decade and Spanish sources differ entirely, so an auto-parsed title is a wrong
 * title written straight into the live catalog with no review step.
 *
 * It is also what buys back reviewability now that ingestion writes directly to the database
 * rather than emitting migrations: the repo no longer contains the text, but it still says
 * exactly what the catalog is.
 *
 * Pure by construction (`lib-patterns` tier 1).
 */

/**
 * Chapter derivation config for one book (spec #33 §4). Either `chaptersHtmlUrl` is set
 * (headings are extracted from the HTML edition) or `chapters.titles` is (the fallback for a
 * source with no structural headings at all) — never both, since which one wins would be
 * ambiguous.
 */
export interface ChaptersConfig {
	/** Tag or tag.class, e.g. `h2`, `h3`, `h2.nobreak`. Default `h2` when `chaptersHtmlUrl` is set. */
	selector?: string;
	/**
	 * Extracted (pre-fold) heading titles to drop before alignment — front/back matter with no
	 * distinguishing `id`, applied by `ingest.ts` between extraction and alignment.
	 */
	excludeTitles?: string[];
	/** Hand-declared titles, in reading order — the fallback path for a book with no HTML edition. */
	titles?: string[];
	/**
	 * True when the first heading's own paragraph is structurally excluded from the cleaned text
	 * by `cleaning.startAtMarker`. Default `false`.
	 */
	firstHeadingImplicit?: boolean;
}

/** One book, as the manifest declares it. */
export interface BookManifestEntry {
	slug: string;
	title: string;
	author: string;
	language: Language;
	sourceUrl: string;
	license: string;
	/** At most one per language. Written and validated in 3a; consumed in 3b (#18). */
	featured: boolean;
	cleaning?: CleaningOverrides;
	/** Cover art, added in 3c (#19). Requires `coverLicense` and `coverSource` when present. */
	cover?: string;
	coverLicense?: string;
	coverSource?: string;
	/** Chapter structure at ingestion (spec #33). Absent on both means "no chapters" — legal. */
	chaptersHtmlUrl?: string;
	chapters?: ChaptersConfig;
	/**
	 * Open Library WORK id, e.g. `/works/OL144961W` (spec #34). Ingestion looks the year and
	 * description up by this declared id and **never by search** — a search for "El Buscón"
	 * surfaces editions dated 1961 and 1979 beside the work's real 1626, and the wrong one
	 * would land in the catalog with nothing to notice it by. The regex below is what enforces
	 * that: there is no field a search term fits in.
	 */
	openLibraryWork?: string;
	/**
	 * The work's first publication year, declared by hand (spec #34). **Wins over Open
	 * Library's `first_publish_year`**, on the same doctrine as the `summary` overrides below:
	 * the manifest is the source of truth, and a third party is a convenience.
	 *
	 * It exists because `first_publish_year` is the earliest edition Open Library has
	 * *catalogued*, which is not the same fact — it reads 1600 for a Quijote first published in
	 * 1605 and 1884 for a Trafalgar first published in 1873. Valid with or without
	 * `openLibraryWork`: a book deliberately given no work id still deserves its year.
	 */
	year?: number;
	/**
	 * Hand-written per-locale summary overrides. A locale key wins over Open Library's
	 * description, which is stored under `default` with its language unverified.
	 *
	 * Keyed on the **UI locale**, not the book's content language: the same Spanish book shows
	 * the English blurb at `/books/el-buscon` and this one at `/es/books/el-buscon`.
	 */
	summary?: Partial<Record<Locale, string>>;
}

/**
 * Validation collects **every** problem rather than throwing on the first. A manifest is
 * hand-edited, and fixing one typo per run to discover the next is a miserable loop.
 */
export type ManifestResult =
	{ ok: true; books: BookManifestEntry[] } | { ok: false; problems: string[] };

const LANGUAGES: readonly string[] = ['en', 'es'];

/**
 * The UI locales a `summary` override may be keyed on. Listed literally, beside `LANGUAGES`,
 * rather than imported from `$lib/paraglide/runtime`: that module is generated at build time
 * and this one is also loaded by `scripts/ingest.ts` as a standalone `tsx` process, outside
 * the SvelteKit build graph, where a runtime import of a generated module would not resolve.
 */
const LOCALES: readonly string[] = ['en', 'es'];

/** Lower-case letters, digits and hyphens: it becomes the `/type/[slug]` URL segment. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const REQUIRED = ['slug', 'title', 'author', 'language', 'sourceUrl', 'license'] as const;

/**
 * An Open Library **work** id and nothing else (spec #34). Not an edition id (`/books/OL…M`,
 * which carries an edition date rather than the work's first publication year), not a URL,
 * not a title to search for.
 */
const OPEN_LIBRARY_WORK = /^\/works\/OL\d+W$/;

/**
 * The plausible range for a declared `year`, mirroring the `books_year_plausible` CHECK
 * constraint exactly (spec #34, Phase 2 migration). Inclusive bounds, as the SQL `between` is.
 *
 * Wide, immutable literals rather than anything derived from the current date — for the same
 * reason the CHECK gives: a bound that tightens as time passes starts rejecting data it once
 * accepted. This is a typo catch, not a claim about publishing history: it is here to stop a
 * Gutenberg id or an ISBN landing in the column, and to catch it in the manifest rather than
 * as a constraint violation halfway through a write.
 */
const YEAR_MIN = -3000;
const YEAR_MAX = 2200;

/** `tag` or `tag.class` — matches `extractHeadings`' own selector syntax. */
const CHAPTERS_SELECTOR = /^[a-z][a-z0-9]*(\.[a-zA-Z0-9_-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a syntactically valid http(s) URL. */
function isHttpUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * Parses and validates the manifest's JSON text.
 *
 * Never throws: malformed JSON is a problem to report like any other, since the caller is a
 * CLI that should print what is wrong rather than a stack trace.
 */
export function parseManifest(raw: string): ManifestResult {
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch (cause) {
		return { ok: false, problems: [`Manifest is not valid JSON: ${(cause as Error).message}`] };
	}

	if (!isRecord(payload) || !Array.isArray(payload.books)) {
		return { ok: false, problems: ['Manifest must be an object with a `books` array.'] };
	}

	const problems: string[] = [];
	const books: BookManifestEntry[] = [];
	const seenSlugs = new Set<string>();
	const featuredByLanguage = new Map<string, string[]>();

	for (const [index, entry] of payload.books.entries()) {
		// Identify the entry by slug where possible; an entry with no slug is only findable
		// by position, so say so rather than reporting an anonymous problem.
		const label = isRecord(entry) && typeof entry.slug === 'string' ? entry.slug : `entry ${index}`;

		if (!isRecord(entry)) {
			problems.push(`${label}: must be an object.`);
			continue;
		}

		for (const field of REQUIRED) {
			if (typeof entry[field] !== 'string' || entry[field] === '') {
				problems.push(`${label}: missing required field \`${field}\`.`);
			}
		}

		if (typeof entry.slug === 'string' && !SLUG.test(entry.slug)) {
			problems.push(`${label}: \`slug\` must be lower-case, digits and hyphens only.`);
		}
		if (typeof entry.slug === 'string') {
			if (seenSlugs.has(entry.slug)) {
				problems.push(`${label}: duplicate slug.`);
			}
			seenSlugs.add(entry.slug);
		}

		if (typeof entry.language === 'string' && !LANGUAGES.includes(entry.language)) {
			problems.push(`${label}: unknown \`language\` "${entry.language}" (expected en or es).`);
		}

		if (typeof entry.sourceUrl === 'string' && !isHttpUrl(entry.sourceUrl)) {
			problems.push(`${label}: \`sourceUrl\` must be an http(s) URL.`);
		}

		// A cover's licence claim is never implicit: Gutenberg's TEXT is public domain, its
		// scanned cover art frequently is not, and the judgement is per image (spec #19 §2).
		if (typeof entry.cover === 'string') {
			if (typeof entry.coverLicense !== 'string' || typeof entry.coverSource !== 'string') {
				problems.push(`${label}: \`cover\` requires both \`coverLicense\` and \`coverSource\`.`);
			}
		}

		if (typeof entry.chaptersHtmlUrl === 'string' && !isHttpUrl(entry.chaptersHtmlUrl)) {
			problems.push(`${label}: \`chaptersHtmlUrl\` must be an http(s) URL.`);
		}

		const chapters = isRecord(entry.chapters) ? entry.chapters : undefined;
		if (chapters) {
			if (typeof chapters.selector === 'string' && !CHAPTERS_SELECTOR.test(chapters.selector)) {
				problems.push(
					`${label}: \`chapters.selector\` is malformed (expected e.g. "h2", "h3.foo").`
				);
			}
			if (chapters.titles !== undefined) {
				const validTitles =
					Array.isArray(chapters.titles) &&
					chapters.titles.length > 0 &&
					chapters.titles.every((t) => typeof t === 'string' && t !== '');
				if (!validTitles) {
					problems.push(
						`${label}: \`chapters.titles\`, when present, must be a non-empty array of non-empty strings.`
					);
				}
			}
		}

		const hasHtmlUrl = typeof entry.chaptersHtmlUrl === 'string';
		const hasTitles = chapters?.titles !== undefined;
		if (hasHtmlUrl && hasTitles) {
			problems.push(
				`${label}: chapters config may declare chaptersHtmlUrl or chapters.titles, not both — ambiguous which wins.`
			);
		}
		if (
			chapters &&
			(chapters.excludeTitles !== undefined ||
				chapters.selector !== undefined ||
				chapters.firstHeadingImplicit !== undefined) &&
			!hasHtmlUrl &&
			!hasTitles
		) {
			problems.push(`${label}: chapters config requires chaptersHtmlUrl or chapters.titles.`);
		}

		// Spec #34. A shape check only — `parseManifest` stays pure, so whether the id RESOLVES
		// is the script's problem, and a wrong-but-well-formed id is a non-fatal 404 there.
		if (entry.openLibraryWork !== undefined) {
			if (
				typeof entry.openLibraryWork !== 'string' ||
				!OPEN_LIBRARY_WORK.test(entry.openLibraryWork)
			) {
				problems.push(
					`${label}: \`openLibraryWork\` must be an Open Library work id like "/works/OL144961W" ` +
						`(never an edition id, a URL, or a title to search for).`
				);
			}
		}

		// A quoted "1605" and a rounded 1605.5 are both refused rather than coerced: `books.year`
		// is an integer column recording a fact, and a manifest that means 1605 should say 1605.
		if (entry.year !== undefined) {
			if (
				typeof entry.year !== 'number' ||
				!Number.isInteger(entry.year) ||
				entry.year < YEAR_MIN ||
				entry.year > YEAR_MAX
			) {
				problems.push(
					`${label}: \`year\` must be a whole number between ${YEAR_MIN} and ${YEAR_MAX} ` +
						`(the work's first publication year — never a Gutenberg id, an ISBN, or an edition date).`
				);
			}
		}

		// An unknown locale key is REPORTED rather than dropped: a typo'd "sp" would otherwise
		// produce a book whose Spanish summary mysteriously never appears, with nothing to say why.
		if (entry.summary !== undefined) {
			if (!isRecord(entry.summary)) {
				problems.push(`${label}: \`summary\`, when present, must be an object keyed by locale.`);
			} else {
				const keys = Object.keys(entry.summary);
				if (keys.length === 0) {
					problems.push(
						`${label}: \`summary\` is empty — omit it entirely rather than declaring nothing.`
					);
				}
				for (const key of keys) {
					if (!LOCALES.includes(key)) {
						problems.push(
							`${label}: \`summary\` has unknown locale key "${key}" (expected ${LOCALES.join(' or ')}).`
						);
					}
					const value = (entry.summary as Record<string, unknown>)[key];
					if (typeof value !== 'string' || value.trim() === '') {
						problems.push(`${label}: \`summary.${key}\` must be a non-empty string.`);
					}
				}
			}
		}

		if (entry.featured === true && typeof entry.language === 'string') {
			const featured = featuredByLanguage.get(entry.language) ?? [];
			featured.push(label);
			featuredByLanguage.set(entry.language, featured);
		}

		books.push({
			slug: String(entry.slug ?? ''),
			title: String(entry.title ?? ''),
			author: String(entry.author ?? ''),
			language: entry.language as Language,
			sourceUrl: String(entry.sourceUrl ?? ''),
			license: String(entry.license ?? ''),
			featured: entry.featured === true,
			...(isRecord(entry.cleaning) ? { cleaning: entry.cleaning as CleaningOverrides } : {}),
			...(typeof entry.cover === 'string' ? { cover: entry.cover } : {}),
			...(typeof entry.coverLicense === 'string' ? { coverLicense: entry.coverLicense } : {}),
			...(typeof entry.coverSource === 'string' ? { coverSource: entry.coverSource } : {}),
			...(typeof entry.chaptersHtmlUrl === 'string'
				? { chaptersHtmlUrl: entry.chaptersHtmlUrl }
				: {}),
			...(chapters ? { chapters: chapters as ChaptersConfig } : {}),
			...(typeof entry.openLibraryWork === 'string'
				? { openLibraryWork: entry.openLibraryWork }
				: {}),
			...(typeof entry.year === 'number' ? { year: entry.year } : {}),
			...(isRecord(entry.summary)
				? { summary: entry.summary as Partial<Record<Locale, string>> }
				: {})
		});
	}

	for (const [language, slugs] of featuredByLanguage) {
		if (slugs.length > 1) {
			problems.push(
				`More than one featured book for language ${language}: ${slugs.join(', ')}. Exactly one may be featured per language.`
			);
		}
	}

	return problems.length > 0 ? { ok: false, problems } : { ok: true, books };
}
