/**
 * Chapter heading extraction from a book's HTML edition (spec #33 §2).
 *
 * The typing text keeps coming from the plain-text edition, cleaned exactly as before — the
 * HTML edition is fetched **only** to learn where chapters begin, and no HTML content ever
 * reaches `chunks`. That narrow purpose is why this is a small, carefully-scoped regex parser
 * rather than a general HTML parser: no such dependency exists in this project, and none is
 * warranted for "read the text of a handful of heading tags."
 *
 * Pure by construction (`lib-patterns` tier 1): a string in, an array out. No network, no
 * filesystem, no clock, no DOM.
 */

/** One heading, as literally found in the HTML — before any title-based editorial filtering. */
export interface ExtractedHeading {
	/** The numeric part of the tag, e.g. `2` for `<h2>`. */
	level: number;
	/** The class attribute's raw value, `''` if absent. */
	className: string;
	/** Decoded, whitespace-collapsed, trimmed — NOT yet folded through `normalizeCharacters`. */
	title: string;
}

/** Project Gutenberg's own boilerplate headings, excluded regardless of selector or book. */
const ALWAYS_EXCLUDED_IDS = ['pg-header-heading', 'pg-footer-heading'];

/** `tag` or `tag.class` — mirrors the pattern `parseManifest` validates `chapters.selector` with. */
const SELECTOR = /^([a-z][a-z0-9]*)(?:\.([a-zA-Z0-9_-]+))?$/;

interface ParsedSelector {
	tag: string;
	className?: string;
}

function parseSelector(selector: string): ParsedSelector {
	const match = SELECTOR.exec(selector);
	if (!match) {
		throw new Error(`extractHeadings: invalid selector "${selector}"`);
	}
	return { tag: match[1], className: match[2] };
}

/** Extracts a named attribute's raw value from a tag's attribute string, if present. */
function attributeValue(attributes: string, name: string): string | undefined {
	const regex = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
	return regex.exec(attributes)?.[1];
}

/** True when `classAttribute`'s space-separated tokens include `className`. */
function hasClassToken(classAttribute: string | undefined, className: string): boolean {
	return (classAttribute ?? '').split(/\s+/).includes(className);
}

/**
 * Removes every `<tag ...>...</tag>` element (across `tags`) whose class attribute carries
 * `className`, content included — used to drop nested page-number and caption decoration
 * BEFORE the heading's own title text is computed, since Gutenberg's HTML editions embed both
 * inside the heading element itself.
 */
function stripElementsByClass(html: string, tags: readonly string[], className: string): string {
	let out = html;
	for (const tag of tags) {
		const regex = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
		out = out.replace(regex, (full, attributes: string) =>
			hasClassToken(attributeValue(attributes, 'class'), className) ? '' : full
		);
	}
	return out;
}

/** Common named entities plus numeric (decimal and hex) references. */
function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		amp: '&',
		lt: '<',
		gt: '>',
		quot: '"',
		apos: "'",
		nbsp: ' '
	};
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&([a-zA-Z]+);/g, (full, name: string) => named[name.toLowerCase()] ?? full);
}

/**
 * Repairs a verified real defect in Project Gutenberg's own HTML: some headings literally read
 * "CHAPTERXXVII." with no space between the chapter word and its own roman numeral, even
 * though the plain-text edition of the same book has "CHAPTER XXVII." correctly spaced
 * (byte-checked against pg1342-images.html). Narrowly scoped to a known chapter word glued to
 * a roman numeral ending in a period — this is a source encoding artifact, not fuzzy prose
 * matching, which the spec explicitly rejects.
 */
const GLUED_CHAPTER_WORD = /(chapter|cap[ií]tulo)([ivxlcdm]+\.)/gi;

function repairGluedHeadingWord(title: string): string {
	return title.replace(
		GLUED_CHAPTER_WORD,
		(_, word: string, numeral: string) => `${word} ${numeral}`
	);
}

/**
 * A heading element's inner HTML → its title text.
 *
 * Order matters: strip the nested decoration FIRST (its content is not part of the title even
 * though it sits inside the heading tag), then strip all remaining tags, decode entities, and
 * collapse whitespace the same way `clean.ts` joins a paragraph's hard-wrapped lines — a single
 * space, however many source lines the heading's own content spanned.
 */
function titleFrom(inner: string): string {
	const withoutDecoration = stripElementsByClass(
		stripElementsByClass(inner, ['span'], 'pagenum'),
		['span', 'div'],
		'caption'
	);
	const withoutTags = withoutDecoration.replace(/<[^>]+>/g, ' ');
	const decoded = decodeEntities(withoutTags);
	return repairGluedHeadingWord(decoded.replace(/\s+/g, ' ').trim());
}

/**
 * HTML → headings matching `selector`, in document order.
 *
 * `excludeIds` is a book-specific exclusion list, separate from the always-on Project Gutenberg
 * header/footer exclusion. Editorial "which of these are actually chapters" filtering by TITLE
 * happens one layer up, in the manifest-driven caller — this function reports "what's literally
 * there," nothing more.
 */
export function extractHeadings(
	html: string,
	selector: string,
	excludeIds: readonly string[] = []
): ExtractedHeading[] {
	const { tag, className } = parseSelector(selector);
	const level = Number(tag.slice(1));
	const regex = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');

	const results: ExtractedHeading[] = [];
	let match: RegExpExecArray | null;
	while ((match = regex.exec(html)) !== null) {
		const [, attributes, inner] = match;

		const id = attributeValue(attributes, 'id');
		if (id && (ALWAYS_EXCLUDED_IDS.includes(id) || excludeIds.includes(id))) {
			continue;
		}

		const rawClassName = attributeValue(attributes, 'class') ?? '';
		if (className && !hasClassToken(rawClassName, className)) {
			continue;
		}

		const title = titleFrom(inner);
		if (title === '') {
			continue;
		}

		results.push({ level, className: rawClassName, title });
	}

	return results;
}
