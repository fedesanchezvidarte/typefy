/**
 * Open Library work payloads → the two back-cover facts a book detail screen shows
 * (spec #34): the work's first publication year and its description.
 *
 * Pure by construction (`lib-patterns` tier 1): no network, no filesystem, no clock. The
 * script owns the request and the cache, exactly as it already does for the source text and
 * the chapters HTML; this module only makes sense of whatever came back.
 *
 * Two properties drive every decision below:
 *
 * 1. **The payload is untrusted and loosely typed.** Open Library serves the same field in
 *    more than one shape, and a work that has never been curated can carry almost anything.
 *    So every field is read defensively and independently — an unusable year never suppresses
 *    a perfectly good description.
 * 2. **Nothing here is fatal.** The caller treats "neither field usable" as a non-fatal
 *    failure and ingests the book anyway. Text and chapters are the product; a blurb is not.
 *
 * **`findDisallowed` is deliberately NOT applied to the description.** ADR-0013's typeable
 * character set governs text a user must *type*, where a character outside the set makes a
 * passage impossible to complete. A summary is display-only and is never typed, so curly
 * quotes, em dashes and ellipses in it are not defects and must survive verbatim. Gating the
 * summary on the typing rule would be a category error, not extra safety.
 */

/**
 * **Where each field comes from, since it is not one endpoint.** `description` lives on the
 * work document (`/works/OL…W.json`); `first_publish_year` does **not** — it only exists on a
 * search document, which the script requests by `key:/works/OL…W` (still by declared id, never
 * by title) and merges in before calling this function. What the work document offers instead
 * is `first_publish_date`, and that is some edition's date: "1853" for Pride and Prejudice,
 * "1896" for Don Quijote. It is deliberately ignored here — a confidently wrong year is the
 * failure the "by declared id only" rule exists to prevent, arriving through another door.
 */

/** What one Open Library work is worth to this project. Both fields are independently optional. */
export interface OpenLibraryWork {
	/** The WORK's first publication year — never an edition date. `null` when unusable. */
	year: number | null;
	/** The description, footnote-stripped and trimmed. `null` when absent or unusable. */
	description: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A whole line that is nothing but a markdown link-reference definition, e.g.
 * `  [1]: https://en.wikipedia.org/wiki/Lazarillo_de_Tormes`.
 */
const LINK_DEFINITION = /^\[\d+\]:\s*\S+$/;

/**
 * A whole line that is nothing but an attribution reference — `([Source][1])`,
 * `[Wikipedia][1]`, `([Wikipedia](https://…))` — optionally introduced by a short label, which
 * is the shape El Buscón's real description ends with (`Fuente/Source: [Wikipedia](…).`).
 *
 * The label is capped at 40 characters and may not contain a full stop, which is what keeps
 * this from swallowing a closing SENTENCE that merely happens to contain a link.
 */
const ATTRIBUTION_LINE = /^(?:[^.\n]{1,40}:\s*)?\(?\[[^\]]+\](?:\[\d+\]|\([^)]*\))\)?\.?$/;

/**
 * The same attribution, left dangling at the END of the final sentence rather than on its own
 * line: `…and his masters. ([source][1])`. Anchored to the end of the string, and required to
 * be preceded by whitespace, so a parenthetical that is part of the prose cannot match.
 */
const TRAILING_ATTRIBUTION = /\s+\(\[[^\]\n]+\](?:\[\d+\]|\([^)\n]*\))\)\.?$/;

/**
 * Removes the source/attribution footnotes Open Library appends to many descriptions.
 *
 * **Conservative and pattern-bounded, deliberately.** Only trailing lines that are *entirely*
 * a link definition or an attribution reference are dropped, and the walk stops at the first
 * line that is not one — so a footnote buried mid-description stays put, and a blurb that
 * matches nothing is returned whole. A leftover footnote is ugly; a truncated blurb is wrong,
 * and there is no review step downstream that would catch the difference.
 */
function stripFootnotes(raw: string): string {
	const lines = raw.split(/\r?\n/);

	while (lines.length > 0) {
		const last = lines[lines.length - 1].trim();
		if (last === '' || LINK_DEFINITION.test(last) || ATTRIBUTION_LINE.test(last)) {
			lines.pop();
			continue;
		}
		break;
	}

	return lines.join('\n').replace(TRAILING_ATTRIBUTION, '').trim();
}

/**
 * The year, from a number or from the numeric string the API also emits.
 *
 * Non-integers are refused rather than rounded: `books.year` records a fact, and inventing a
 * year from `1626.5` would put a number in the catalog that no source states. Negative years
 * are legal — antiquity is in scope for a public-domain catalog.
 */
function parseYear(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isInteger(value) ? value : null;
	}
	if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
		return Number.parseInt(value.trim(), 10);
	}
	return null;
}

/** The description, from either shape Open Library serves it in. Anything else → `null`. */
function parseDescription(value: unknown): string | null {
	let raw: string | null = null;

	if (typeof value === 'string') {
		raw = value;
	} else if (isRecord(value) && typeof value.value === 'string') {
		// `{ type: '/type/text', value: '…' }`. The `type` discriminator is not required to
		// match: the usable content is the string, and refusing a payload over a `type` field
		// nobody displays would lose a good description for a cosmetic reason.
		raw = value.value;
	}

	if (raw === null) {
		return null;
	}

	const stripped = stripFootnotes(raw);
	return stripped === '' ? null : stripped;
}

/**
 * Reads an Open Library work payload. Never throws: an unrecognisable payload is
 * `{ year: null, description: null }`, which the caller reports as a non-fatal failure.
 */
export function parseOpenLibraryWork(payload: unknown): OpenLibraryWork {
	if (!isRecord(payload)) {
		return { year: null, description: null };
	}
	return {
		year: parseYear(payload.first_publish_year),
		description: parseDescription(payload.description)
	};
}
