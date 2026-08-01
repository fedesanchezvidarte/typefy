import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { Chunk, ChunkWindowResponse } from '$lib/types';
import { getBookSummaryBySlug, getChunkWindow } from '$lib/server/books';
import { clampWindow, type WindowBounds } from '$lib/reading/window';
import { failure, parseRange } from '../range';

/**
 * `GET /api/books/[slug]/chunks?from=&limit=` — the public window endpoint (spec #18 §4).
 *
 * Windows 2..n of a book arrive here; window 1 is inlined by the `/type/[slug]` load, so
 * this is never on the first paint's critical path.
 *
 * **This handler consults no session, and must not start.** It never calls
 * `locals.safeGetSession()` or any other auth helper. Two reasons, both load-bearing:
 *
 * 1. The response is `public, s-maxage`. A session check can refresh a token and attach
 *    `Set-Cookie`, which on a shared-cacheable response is the classic cache-poisoning
 *    shape — one user's refreshed session handed to the next reader of the same window.
 * 2. The body is a pure function of `(slug, from, limit)` and the chunk rows. There is no
 *    per-user byte in it to leak, **structurally** — not by a `Vary` header a proxy has to
 *    honour. Per-user completed ids live on the sibling `/progress` endpoint, which is
 *    `private, no-store` and is only called when signed in.
 *
 * So this response sets no `Vary` of its own, and its `ETag` is a genuine strong validator
 * over the chunk content: it changes when a re-ingest corrects a typo, which is exactly the
 * revalidation story ADR-0006's upsert-in-place model needs and the reason the spec chose
 * `s-maxage` + `stale-while-revalidate` over `immutable`.
 *
 * Publication is enforced by RLS, not by a filter: reading through the request-scoped
 * `locals.supabase` means the 20260731120000 policy makes an unpublished book
 * indistinguishable from a nonexistent one, for `anon` and `authenticated` alike. That
 * identical-404 property is an acceptance criterion, and relying on the policy for it is
 * what makes it hold for every caller rather than for this one handler's care.
 */

/**
 * Five minutes of shared cache, a day of stale-while-revalidate, and `max-age=0` so the
 * browser always revalidates while the CDN absorbs the load. Content changes only on a
 * re-ingest, and the ETag catches that on the first revalidation after it.
 */
const CHUNKS_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';

export const GET: RequestHandler = async ({ params, url, locals, request }) => {
	const parsed = parseRange(url);
	if (!parsed.ok) {
		return failure(400, parsed.reason);
	}

	const book = await getBookSummaryBySlug(locals.supabase, params.slug);
	if (!book) {
		return failure(404, 'Book not found');
	}

	// `limit` above MAX_WINDOW_LIMIT is clamped to a 200, never a 400 — that clamp is what
	// stops this endpoint being turned into a whole-book download, which would reintroduce
	// the silent PostgREST row-limit truncation the windowing exists to remove.
	const bounds = clampWindow(parsed.range.from, parsed.range.limit, book.chunkCount);
	const chunks = await getChunkWindow(locals.supabase, book, bounds.from, bounds.limit);

	// `from >= chunkCount` lands here with `limit: 0` and an empty list: a 200, not a 404.
	// The book exists; that range of it does not — and `chunkCount` tells the client so.
	const body: ChunkWindowResponse = {
		from: bounds.from,
		chunks,
		chunkCount: book.chunkCount
	};

	const etag = chunkWindowEtag(params.slug, bounds, chunks);
	const headers = { 'cache-control': CHUNKS_CACHE_CONTROL, etag };

	if (isNoneMatch(request.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers });
	}
	return json(body, { headers });
};

/**
 * A strong ETag over everything the body depends on: the identity of the range and the
 * content served for it. `chunkCount` is deliberately absent — it is `book.chunk_count`,
 * which cannot change without the chunk rows changing too, and including it would make a
 * no-op re-ingest that rewrites the count invalidate every window of the book.
 *
 * Quoted with no `W/` prefix because it IS strong: byte-for-byte, this entity is that
 * content. Two users asking for the same range get the same validator, which is precisely
 * what a fused per-user body could never offer.
 */
function chunkWindowEtag(slug: string, bounds: WindowBounds, chunks: readonly Chunk[]): string {
	// Serialised as JSON rather than concatenated: the escaping makes field boundaries
	// unforgeable by content, so a chunk whose text happens to end in the next chunk's id
	// cannot hash identically to a genuinely different window.
	const material = JSON.stringify([
		slug,
		bounds.from,
		bounds.limit,
		...chunks.flatMap((chunk) => [chunk.id, chunk.content])
	]);

	// Two independently seeded 32-bit FNV-1a passes plus the length: 64 bits of validator
	// with a length check on top, computed in `Math.imul` integer arithmetic rather than
	// through a hash import. An ETag needs determinism and collision resistance against
	// accident, not against an adversary — nothing is authenticated by this value.
	return `"${material.length.toString(36)}-${fnv1a32(material, 0x811c9dc5)}-${fnv1a32(material, 0x9dc5811c)}"`;
}

function fnv1a32(value: string, seed: number): string {
	let hash = seed;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

/**
 * RFC 9110 `If-None-Match`: a comma-separated list, `*`, and entity-tags that may carry a
 * `W/` prefix. Revalidation uses the **weak** comparison function, so `W/"x"` matches `"x"`
 * — a cache that downgraded our validator still gets its 304 rather than a needless 5 KB.
 */
function isNoneMatch(header: string | null, etag: string): boolean {
	if (!header) {
		return false;
	}
	return header
		.split(',')
		.map((candidate) => candidate.trim().replace(/^W\//, ''))
		.some((candidate) => candidate === '*' || candidate === etag);
}
