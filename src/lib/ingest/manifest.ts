import type { CleaningOverrides } from './clean.js';
import type { Language } from '$lib/types';

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
}

/**
 * Validation collects **every** problem rather than throwing on the first. A manifest is
 * hand-edited, and fixing one typo per run to discover the next is a miserable loop.
 */
export type ManifestResult =
	{ ok: true; books: BookManifestEntry[] } | { ok: false; problems: string[] };

const LANGUAGES: readonly string[] = ['en', 'es'];

/** Lower-case letters, digits and hyphens: it becomes the `/type/[slug]` URL segment. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const REQUIRED = ['slug', 'title', 'author', 'language', 'sourceUrl', 'license'] as const;

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
			...(typeof entry.coverSource === 'string' ? { coverSource: entry.coverSource } : {})
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
