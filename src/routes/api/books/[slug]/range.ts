import { json } from '@sveltejs/kit';

/**
 * The `?from=&limit=` contract shared by the two window endpoints (spec #18 §4).
 *
 * Not a route module — SvelteKit only treats `+`-prefixed files as routes — so this sits
 * beside the two `+server.ts` files it serves precisely because it is theirs alone. Both
 * endpoints must answer 400 on exactly the same inputs; a second copy of the matrix is a
 * second place for it to drift.
 *
 * **Reject, never fall back.** This is the deliberate asymmetry with `?passage=N`, whose
 * silent fallback exists because a human may hand-edit it (`resolveStartIndex`). These
 * callers are machines: a malformed range is a bug in the caller, and coercing it silently
 * would serve a different window than was asked for and leave the client's own bookkeeping
 * — which chunk indices it believes it now holds — quietly wrong.
 *
 * The validity test is the same base-10 **integer literal** discipline `resolveStartIndex`
 * uses: `/^\d+$/` on the raw string before parsing, so `-1`, `2.0`, `1e2`, `0x2`, `+2`,
 * `' 3 '` and the empty string are all rejected rather than accepted by a bare `Number()`.
 * A missing parameter is rejected too — there is no default range.
 *
 * `limit` is additionally required to be at least 1: `limit=0` is a malformed request, not
 * a request for nothing. (An EMPTY window is still a legitimate 200 — that is
 * `from >= chunkCount`, which `clampWindow` produces from a well-formed request.)
 *
 * The upper bound on `limit` is NOT enforced here: `limit > MAX_WINDOW_LIMIT` is clamped to
 * a 200, not rejected, and that clamp lives in `clampWindow` with the rest of the window
 * policy.
 */

/** A passage/range param is valid only as a base-10 integer literal: digits, nothing else. */
const INTEGER_LITERAL = /^\d+$/;

/** A well-formed, not-yet-clamped request range. */
export interface RequestedRange {
	from: number;
	limit: number;
}

/** Parsed range, or the reason it is a 400. Never throws. */
export type RangeResult = { ok: true; range: RequestedRange } | { ok: false; reason: string };

const FROM_REASON = '`from` must be a base-10 integer literal of zero or more';
const LIMIT_REASON = '`limit` must be a base-10 integer literal of one or more';

export function parseRange(url: URL): RangeResult {
	const from = url.searchParams.get('from');
	if (from === null || !INTEGER_LITERAL.test(from)) {
		return { ok: false, reason: FROM_REASON };
	}

	const limit = url.searchParams.get('limit');
	if (limit === null || !INTEGER_LITERAL.test(limit)) {
		return { ok: false, reason: LIMIT_REASON };
	}
	const parsedLimit = Number.parseInt(limit, 10);
	if (parsedLimit < 1) {
		return { ok: false, reason: LIMIT_REASON };
	}

	return { ok: true, range: { from: Number.parseInt(from, 10), limit: parsedLimit } };
}

/**
 * A failure response, uncacheable.
 *
 * Returned rather than thrown through `error()`, which is the convention elsewhere in
 * `src/routes/api/` — the one deliberate deviation in this feature, and only here. A
 * thrown `HttpError` cannot carry headers, and `no-store` on these two endpoints' failures
 * is a correctness requirement, not a nicety: `/chunks` answers 200 with
 * `public, s-maxage=300`, so a shared cache is already keyed on its URL. A 404 for a book
 * that is merely awaiting publication must not be storable, or publishing it would leave
 * the CDN serving "no such book" until the entry expired. The body is `{ message }`,
 * matching what `error()` itself serialises, so a client cannot tell the two apart.
 */
export function failure(status: number, message: string): Response {
	return json({ message }, { status, headers: { 'cache-control': 'no-store' } });
}
