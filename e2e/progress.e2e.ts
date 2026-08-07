import { expect, test } from '@playwright/test';
import {
	anonClient,
	deleteUsers,
	epoch,
	isLocalStack,
	readSeededBook,
	signUpUser,
	SUPABASE_URL,
	type AnyClient,
	type SeededBook,
	type TestUser
} from './support/supabase';

/**
 * The `chunk_attempts` rollup trigger (spec #12 §2,
 * `20260726002115_rollup_chunk_attempts.sql`), exercised against the local Supabase
 * stack.
 *
 * Database-level tests, following the `rls.e2e.ts` pattern: throwaway users signed up
 * against the local stack, PostgREST driven directly through supabase-js, no page ever
 * opened, no pgTAP. They live in the Playwright suite because the unit suite is
 * forbidden from touching a real database (testing-patterns).
 *
 * The trigger is the sole writer of both rollups, so every assertion here is a read of
 * what an *insert into `chunk_attempts`* produced — the tests never write a rollup.
 *
 * They create throwaway users, so they refuse to run against anything but a local stack.
 */

/** A book with enough chunks to complete end-to-end, per the seed. */
const BOOK_SLUG = 'don-quijote-excerpt';
/** A second book, so chunk_progress cases never collide with the whole-book invariant. */
const OTHER_BOOK_SLUG = 'pride-and-prejudice-excerpt';

/** Read the real seeded shape rather than assuming it — shared with the auth fixture. */
const readBook = readSeededBook;

/**
 * The best guard's floor (spec #24 §6): a measured span shorter than this many characters
 * is stored but never sets a `best_*`. Duplicated from the migration deliberately — a test
 * that imported the constant would agree with the code by construction and prove nothing.
 */
const BEST_GUARD_CHARS = 100;

/** A measured span comfortably over the floor: a real chunk is 400-600 chars (ADR-0005). */
const FULL_SPAN_CHARS = 420;

interface AttemptInput {
	chunkId: string;
	bookId: string;
	completed?: boolean;
	grossWpm?: number | null;
	accuracyRaw?: number | null;
	elapsedMs?: number;
	/** Client-supplied and informational only: no rollup rule may read it. */
	startedAt?: string;
	/** Spec #24. Defaults describe a whole passage typed in Normal — what every pre-4a case was. */
	mode?: 'normal' | 'zen';
	measuredMs?: number;
	measuredChars?: number;
}

/**
 * Insert one attempt as `user` and return the server clock it was stamped with. Every
 * rollup timestamp must equal this value, never the client-supplied `started_at`.
 *
 * Since spec #24 an attempt also states WHAT IT MEASURED, and the defaults here say "a
 * whole passage, in Normal" — which is what every attempt in this file was before 4a, and
 * what §8's backfill asserts of every pre-existing row. That matters for the `best_*`
 * cases below: `measured_chars` defaults to 0 in the schema, and the best guard reads it,
 * so an attempt that omits the column can never set a best. Leaving the omission in place
 * would have quietly turned every best assertion in this file into an assertion about the
 * guard instead of about the rollup.
 */
async function insertAttempt(user: TestUser, input: AttemptInput): Promise<string> {
	const elapsedMs = input.elapsedMs ?? 30_000;
	const { data, error } = await user.client
		.from('chunk_attempts')
		.insert({
			user_id: user.id,
			chunk_id: input.chunkId,
			book_id: input.bookId,
			completed: input.completed ?? true,
			gross_wpm: input.grossWpm === undefined ? 50 : input.grossWpm,
			accuracy_raw: input.accuracyRaw === undefined ? 0.9 : input.accuracyRaw,
			elapsed_ms: elapsedMs,
			started_at: input.startedAt ?? new Date().toISOString(),
			mode: input.mode ?? 'normal',
			measured_ms: input.measuredMs ?? elapsedMs,
			measured_chars: input.measuredChars ?? FULL_SPAN_CHARS
		})
		.select('created_at')
		.single();
	expect(error, `inserting an attempt failed: ${error?.message}`).toBeNull();
	return data!.created_at;
}

async function readChunkProgress(user: TestUser, chunkId: string) {
	const { data, error } = await user.client
		.from('chunk_progress')
		.select('*')
		.eq('chunk_id', chunkId)
		.single();
	expect(error, `chunk_progress read failed: ${error?.message}`).toBeNull();
	return data!;
}

async function readBookProgress(user: TestUser, bookId: string) {
	const { data, error } = await user.client
		.from('book_progress')
		.select('*')
		.eq('book_id', bookId)
		.single();
	expect(error, `book_progress read failed: ${error?.message}`).toBeNull();
	return data!;
}

/** How many of this user's chunks in this book have ever been completed. */
async function countCompletedChunks(user: TestUser, bookId: string): Promise<number> {
	const { count, error } = await user.client
		.from('chunk_progress')
		.select('*', { count: 'exact', head: true })
		.eq('book_id', bookId)
		.not('first_completed_at', 'is', null);
	expect(error, `counting completed chunks failed: ${error?.message}`).toBeNull();
	return count ?? 0;
}

test.describe('chunk_progress rollup', () => {
	// Serial: the tests share one signed-up user, and several accumulate attempts on
	// their own chunk. Each criterion still takes a FRESH chunk so they cannot couple.
	test.describe.configure({ mode: 'serial' });
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	let typist: TestUser;
	let book: SeededBook;

	test.beforeAll(async () => {
		const anon = anonClient();
		[typist, book] = await Promise.all([signUpUser('progress'), readBook(anon, OTHER_BOOK_SLUG)]);
		expect(book.chunkCount, 'this describe needs one fresh chunk per test').toBeGreaterThanOrEqual(
			5
		);
	});

	test.afterAll(async () => {
		await deleteUsers(typist.id);
	});

	test('a first completed attempt creates the row with the attempt’s bests and timestamps', async () => {
		const chunkId = book.chunkIds[0];
		const createdAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 61.25,
			accuracyRaw: 0.94
		});

		const row = await readChunkProgress(typist, chunkId);
		expect(row.book_id).toBe(book.id);
		expect(row.attempt_count).toBe(1);
		expect(Number(row.best_wpm)).toBeCloseTo(61.25, 6);
		expect(Number(row.best_accuracy_raw)).toBeCloseTo(0.94, 6);
		expect(epoch(row.first_completed_at)).toBe(epoch(createdAt));
		expect(epoch(row.last_attempt_at)).toBe(epoch(createdAt));
	});

	test('a second, better attempt raises the bests and moves last_attempt_at but not first_completed_at', async () => {
		const chunkId = book.chunkIds[1];
		const firstAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 40,
			accuracyRaw: 0.8
		});
		const secondAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 72.5,
			accuracyRaw: 0.99
		});
		expect(epoch(secondAt), 'the two inserts must be distinguishable in time').toBeGreaterThan(
			epoch(firstAt)
		);

		const row = await readChunkProgress(typist, chunkId);
		expect(row.attempt_count).toBe(2);
		expect(Number(row.best_wpm)).toBeCloseTo(72.5, 6);
		expect(Number(row.best_accuracy_raw)).toBeCloseTo(0.99, 6);
		expect(epoch(row.last_attempt_at)).toBe(epoch(secondAt));
		// Written once on the first completion, never moved.
		expect(epoch(row.first_completed_at)).toBe(epoch(firstAt));
	});

	test('a second, worse attempt does not lower the bests', async () => {
		const chunkId = book.chunkIds[2];
		const firstAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 80,
			accuracyRaw: 0.99
		});
		const secondAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 12,
			accuracyRaw: 0.31
		});

		const row = await readChunkProgress(typist, chunkId);
		expect(row.attempt_count).toBe(2);
		expect(Number(row.best_wpm)).toBeCloseTo(80, 6);
		expect(Number(row.best_accuracy_raw)).toBeCloseTo(0.99, 6);
		expect(epoch(row.last_attempt_at)).toBe(epoch(secondAt));
		expect(epoch(row.first_completed_at)).toBe(epoch(firstAt));
	});

	test('rollup timestamps track created_at, not the client-supplied started_at', async () => {
		const chunkId = book.chunkIds[3];
		const before = Date.now();
		const createdAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			startedAt: '1999-01-01T00:00:00.000Z'
		});
		const after = Date.now();

		const row = await readChunkProgress(typist, chunkId);
		expect(epoch(row.last_attempt_at)).toBe(epoch(createdAt));
		expect(epoch(row.first_completed_at)).toBe(epoch(createdAt));

		// The server clock, not 1999: bracketed by the test's own clock rather than
		// compared to a hardcoded date, so this stays true whenever it runs.
		for (const stamp of [row.last_attempt_at, row.first_completed_at]) {
			expect(epoch(stamp)).toBeGreaterThanOrEqual(before - 1_000);
			expect(epoch(stamp)).toBeLessThanOrEqual(after + 1_000);
		}

		// The client value survives untouched on the immutable attempt row itself.
		const attempt = await typist.client
			.from('chunk_attempts')
			.select('started_at')
			.eq('chunk_id', chunkId)
			.single();
		expect(epoch(attempt.data!.started_at)).toBe(Date.parse('1999-01-01T00:00:00.000Z'));
	});

	test('a client cannot supply created_at, so it cannot steer the rollup timestamps', async () => {
		// The test above proves the trigger ignores started_at. This proves the other
		// half: created_at — which every rollup timestamp IS — is not the client's to
		// set. 2a's table-level INSERT grant covered it; the 2b migration re-grants
		// INSERT per column with created_at omitted.
		const chunkId = book.chunkIds[0];
		const countAttempts = async () => {
			const { count } = await typist.client
				.from('chunk_attempts')
				.select('*', { count: 'exact', head: true })
				.eq('chunk_id', chunkId);
			return count;
		};
		const before = await countAttempts();

		const attempt = await typist.client.from('chunk_attempts').insert({
			user_id: typist.id,
			chunk_id: chunkId,
			book_id: book.id,
			completed: true,
			gross_wpm: 60,
			accuracy_raw: 0.95,
			elapsed_ms: 30_000,
			started_at: new Date().toISOString(),
			created_at: '1999-01-01T00:00:00.000Z'
		});

		// 42501 — insufficient privilege on the column, refused before RLS is consulted.
		expect(attempt.error, 'a client-supplied created_at was accepted').not.toBeNull();
		expect(attempt.error!.code).toBe('42501');

		// Refused outright: no attempt row was written, so no rollup could have moved.
		expect(await countAttempts()).toBe(before);
	});

	test('an incomplete attempt counts and moves last_attempt_at but touches nothing else', async () => {
		const chunkId = book.chunkIds[4];
		const completedAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 55,
			accuracyRaw: 0.88
		});
		// A completed=false row is never written by 2b, but RLS permits a client to insert
		// one, so the trigger must handle it defensively (spec #12 §2).
		const incompleteAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			completed: false,
			grossWpm: 999,
			accuracyRaw: 1
		});

		const row = await readChunkProgress(typist, chunkId);
		expect(row.attempt_count).toBe(2);
		expect(epoch(row.last_attempt_at)).toBe(epoch(incompleteAt));
		// Untouched by the incomplete attempt, despite its far better numbers.
		expect(Number(row.best_wpm)).toBeCloseTo(55, 6);
		expect(Number(row.best_accuracy_raw)).toBeCloseTo(0.88, 6);
		expect(epoch(row.first_completed_at)).toBe(epoch(completedAt));
	});
});

test.describe('book_progress rollup', () => {
	// Serial: every test here accumulates state on one user + one book, which is the
	// point — chunks_completed is a property of the whole history, not of one insert.
	test.describe.configure({ mode: 'serial' });
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	let reader: TestUser;
	let book: SeededBook;

	test.beforeAll(async () => {
		const anon = anonClient();
		[reader, book] = await Promise.all([signUpUser('progress'), readBook(anon, BOOK_SLUG)]);
	});

	test.afterAll(async () => {
		await deleteUsers(reader.id);
	});

	test('a chunk’s first completion sets chunks_completed to 1 and last_active_at to created_at', async () => {
		const createdAt = await insertAttempt(reader, {
			chunkId: book.chunkIds[0],
			bookId: book.id
		});

		const row = await readBookProgress(reader, book.id);
		expect(row.chunks_completed).toBe(1);
		expect(epoch(row.last_active_at)).toBe(epoch(createdAt));
	});

	test('re-completing an already-completed chunk moves last_active_at but does not advance', async () => {
		const before = await readBookProgress(reader, book.id);
		const createdAt = await insertAttempt(reader, {
			chunkId: book.chunkIds[0],
			bookId: book.id
		});

		const row = await readBookProgress(reader, book.id);
		expect(row.chunks_completed).toBe(before.chunks_completed);
		expect(epoch(row.last_active_at)).toBe(epoch(createdAt));
		expect(epoch(row.last_active_at)).toBeGreaterThan(epoch(before.last_active_at));
	});

	test('an incomplete attempt on a fresh chunk moves last_active_at but does not advance', async () => {
		const before = await readBookProgress(reader, book.id);
		const createdAt = await insertAttempt(reader, {
			chunkId: book.chunkIds[1],
			bookId: book.id,
			completed: false
		});

		const row = await readBookProgress(reader, book.id);
		expect(row.chunks_completed).toBe(before.chunks_completed);
		expect(epoch(row.last_active_at)).toBe(epoch(createdAt));
		expect(epoch(row.last_active_at)).toBeGreaterThan(epoch(before.last_active_at));
	});

	test('chunks_completed always equals the completed-chunk count and never exceeds chunk_count', async () => {
		// chunks_completed is COUNTED over chunk_progress, not incremented, so there is no
		// "did it increment?" branch worth probing. What matters is the invariant, so this
		// drives an arbitrary sequence of attempts and re-checks it after EVERY insert:
		// a full pass over the book, then re-completions of already-complete chunks, then
		// an incomplete attempt.
		const sequence: AttemptInput[] = [
			...book.chunkIds.map((chunkId) => ({ chunkId, bookId: book.id })),
			{ chunkId: book.chunkIds[2], bookId: book.id },
			{ chunkId: book.chunkIds[0], bookId: book.id },
			{ chunkId: book.chunkIds[book.chunkCount - 1], bookId: book.id },
			{ chunkId: book.chunkIds[3], bookId: book.id, completed: false }
		];

		for (const [step, input] of sequence.entries()) {
			const createdAt = await insertAttempt(reader, input);
			const row = await readBookProgress(reader, book.id);
			const completedChunks = await countCompletedChunks(reader, book.id);
			const where = `after step ${step} (chunk ${book.chunkIds.indexOf(input.chunkId)}, completed=${input.completed ?? true})`;

			expect(row.chunks_completed, `chunks_completed disagrees with chunk_progress ${where}`).toBe(
				completedChunks
			);
			expect(
				row.chunks_completed,
				`chunks_completed exceeded the book's chunk_count ${where}`
			).toBeLessThanOrEqual(book.chunkCount);
			expect(epoch(row.last_active_at), `last_active_at did not track created_at ${where}`).toBe(
				epoch(createdAt)
			);
		}

		// The full pass above completed every chunk, so the invariant has been driven to
		// its ceiling: 100% and no further.
		const final = await readBookProgress(reader, book.id);
		expect(final.chunks_completed).toBe(book.chunkCount);
	});
});

/**
 * Mode and measured spans (spec #24 §§5-7), at the level where they are actually decided.
 *
 * The engine's own rules are unit-tested and the write path is component-tested with a
 * mocked client; neither can see the trigger. Everything below is a property of the
 * DATABASE — a CHECK constraint, a column-level grant, and a rewritten
 * `apply_chunk_attempt_rollups()` — so it is asserted the only honest way: by inserting a
 * real row through PostgREST as a real user and reading back what the trigger produced.
 */
test.describe('mode and the best guard (spec #24)', () => {
	// Serial, one user, a fresh chunk per test — same shape and same reasoning as the
	// chunk_progress describe above.
	test.describe.configure({ mode: 'serial' });
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	let typist: TestUser;
	let book: SeededBook;

	test.beforeAll(async () => {
		const anon = anonClient();
		[typist, book] = await Promise.all([signUpUser('progress'), readBook(anon, OTHER_BOOK_SLUG)]);
		expect(book.chunkCount, 'this describe needs one fresh chunk per test').toBeGreaterThanOrEqual(
			5
		);
	});

	test.afterAll(async () => {
		await deleteUsers(typist.id);
	});

	test('the axis is closed: a value outside normal|zen is refused by the constraint', async () => {
		// The value a future page-view presentation would be tempted to fold into this
		// column (§1). The database is where that temptation is stopped.
		const refused = await typist.client.from('chunk_attempts').insert({
			user_id: typist.id,
			chunk_id: book.chunkIds[0],
			book_id: book.id,
			completed: true,
			gross_wpm: 50,
			accuracy_raw: 0.9,
			elapsed_ms: 30_000,
			started_at: new Date().toISOString(),
			mode: 'zen-page' as 'normal' | 'zen',
			measured_ms: 30_000,
			measured_chars: FULL_SPAN_CHARS
		});
		expect(refused.error, 'a mode outside the axis was accepted').not.toBeNull();
		expect(refused.error!.code, refused.error!.message).toBe('23514'); // check_violation
	});

	test('measured_ms may not exceed elapsed_ms', async () => {
		// §5: `measured_ms <= elapsed_ms` always, and they are equal exactly when the whole
		// traversal was Normal. A row claiming to have measured more than the wall clock is
		// nonsense no client should be able to file.
		const refused = await typist.client.from('chunk_attempts').insert({
			user_id: typist.id,
			chunk_id: book.chunkIds[0],
			book_id: book.id,
			completed: true,
			gross_wpm: 50,
			accuracy_raw: 0.9,
			elapsed_ms: 10_000,
			started_at: new Date().toISOString(),
			mode: 'normal',
			measured_ms: 10_001,
			measured_chars: FULL_SPAN_CHARS
		});
		expect(refused.error, 'measured_ms > elapsed_ms was accepted').not.toBeNull();
		expect(refused.error!.code, refused.error!.message).toBe('23514');
	});

	test('the column-level INSERT grant reaches the three new columns, and still not id', async () => {
		// §7: the 2b migration replaced the table-level grant with a column-level one, so a
		// new column that is not named in it fails SILENTLY at the client. This is the
		// assertion that would have caught that — a round trip of all three values.
		const chunkId = book.chunkIds[1];
		await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			mode: 'zen',
			grossWpm: null,
			accuracyRaw: null,
			elapsedMs: 20_000,
			measuredMs: 7_500,
			measuredChars: 250
		});

		const stored = await typist.client
			.from('chunk_attempts')
			.select('mode, measured_ms, measured_chars, gross_wpm, accuracy_raw')
			.eq('chunk_id', chunkId)
			.single();
		expect(stored.error, `attempt read failed: ${stored.error?.message}`).toBeNull();
		expect(stored.data).toEqual({
			mode: 'zen',
			measured_ms: 7_500,
			measured_chars: 250,
			gross_wpm: null,
			accuracy_raw: null
		});

		// `id` stays omitted from the grant alongside `created_at`, so it keeps falling to
		// its default. (`created_at` has its own test in the chunk_progress describe.)
		const refused = await typist.client.from('chunk_attempts').insert({
			id: '00000000-0000-4000-8000-000000000001',
			user_id: typist.id,
			chunk_id: chunkId,
			book_id: book.id,
			completed: true,
			gross_wpm: 50,
			accuracy_raw: 0.9,
			elapsed_ms: 30_000,
			started_at: new Date().toISOString()
		});
		expect(refused.error, 'a client-supplied id was accepted').not.toBeNull();
		expect(refused.error!.code).toBe('42501');
	});

	test('a completed Zen attempt is progress: it counts and completes, but sets no best', async () => {
		const chunkId = book.chunkIds[2];
		const zenAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			mode: 'zen',
			grossWpm: null,
			accuracyRaw: null,
			measuredMs: 0,
			measuredChars: 0
		});

		const row = await readChunkProgress(typist, chunkId);
		expect(row.attempt_count).toBe(1);
		expect(epoch(row.last_attempt_at)).toBe(epoch(zenAt));
		// "Zen progress is progress" (§7): the passage is completed, and resume, book
		// percentages and continue-reading all read this timestamp.
		expect(epoch(row.first_completed_at)).toBe(epoch(zenAt));
		// Nothing was measured, so there is nothing to be best at — null, not zero.
		expect(row.best_wpm).toBeNull();
		expect(row.best_accuracy_raw).toBeNull();
	});

	test('a Zen attempt never disturbs a best a Normal attempt already set', async () => {
		const chunkId = book.chunkIds[3];
		const normalAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 70,
			accuracyRaw: 0.98
		});
		const zenAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			mode: 'zen',
			grossWpm: null,
			accuracyRaw: null,
			measuredMs: 0,
			measuredChars: 0
		});

		const row = await readChunkProgress(typist, chunkId);
		expect(row.attempt_count).toBe(2);
		expect(epoch(row.last_attempt_at)).toBe(epoch(zenAt));
		expect(epoch(row.first_completed_at)).toBe(epoch(normalAt));
		// `greatest()` ignores NULLs, but the `case` arms are what actually decide this:
		// a NULL-metric attempt must not reach them at all.
		expect(Number(row.best_wpm)).toBeCloseTo(70, 6);
		expect(Number(row.best_accuracy_raw)).toBeCloseTo(0.98, 6);
	});

	test('the best guard is a floor at 100 measured characters, tested on both sides of it', async () => {
		const chunkId = book.chunkIds[4];

		// One character short: stored, counted, completed — and never a best, however
		// spectacular the rate. This is the short end-of-passage sprint §6 exists to stop.
		const shortAt = await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 400,
			accuracyRaw: 1,
			measuredChars: BEST_GUARD_CHARS - 1
		});
		let row = await readChunkProgress(typist, chunkId);
		expect(row.attempt_count).toBe(1);
		expect(epoch(row.first_completed_at)).toBe(epoch(shortAt));
		expect(row.best_wpm, 'a 99-character span set a best').toBeNull();
		expect(row.best_accuracy_raw).toBeNull();

		// Exactly at the floor: the guard is `>=`, so this one counts. Asserted at the
		// boundary rather than comfortably past it — an off-by-one in the migration is
		// invisible to any test that only ever measures whole passages.
		await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 65,
			accuracyRaw: 0.91,
			measuredChars: BEST_GUARD_CHARS
		});
		row = await readChunkProgress(typist, chunkId);
		expect(row.attempt_count).toBe(2);
		expect(Number(row.best_wpm)).toBeCloseTo(65, 6);
		expect(Number(row.best_accuracy_raw)).toBeCloseTo(0.91, 6);

		// And a later short sprint still cannot beat it.
		await insertAttempt(typist, {
			chunkId,
			bookId: book.id,
			grossWpm: 999,
			accuracyRaw: 1,
			measuredChars: 20
		});
		row = await readChunkProgress(typist, chunkId);
		expect(row.attempt_count).toBe(3);
		expect(Number(row.best_wpm)).toBeCloseTo(65, 6);
		expect(Number(row.best_accuracy_raw)).toBeCloseTo(0.91, 6);
	});

	test('book_progress counts a Zen completion exactly like a Normal one', async () => {
		// §7 again, one level up: completion percentages, resume and continue-reading must
		// behave identically in both modes. A second book, so this cannot collide with the
		// per-chunk cases above.
		const anon = anonClient();
		const otherBook = await readBook(anon, BOOK_SLUG);
		const reader = await signUpUser('progress');
		try {
			await insertAttempt(reader, {
				chunkId: otherBook.chunkIds[0],
				bookId: otherBook.id,
				mode: 'zen',
				grossWpm: null,
				accuracyRaw: null,
				measuredMs: 0,
				measuredChars: 0
			});
			let row = await readBookProgress(reader, otherBook.id);
			expect(row.chunks_completed).toBe(1);

			await insertAttempt(reader, {
				chunkId: otherBook.chunkIds[1],
				bookId: otherBook.id,
				mode: 'normal'
			});
			row = await readBookProgress(reader, otherBook.id);
			expect(row.chunks_completed).toBe(2);
			expect(await countCompletedChunks(reader, otherBook.id)).toBe(2);
		} finally {
			await deleteUsers(reader.id);
		}
	});
});

test.describe('rollup isolation once the trigger has populated them', () => {
	test.describe.configure({ mode: 'serial' });
	test.skip(
		!isLocalStack,
		`refusing to create throwaway users against a non-local Supabase (${SUPABASE_URL})`
	);

	let anon: AnyClient;
	let owner: TestUser;
	let stranger: TestUser;
	let book: SeededBook;

	test.beforeAll(async () => {
		anon = anonClient();
		[owner, stranger, book] = await Promise.all([
			signUpUser('progress'),
			signUpUser('progress'),
			readBook(anon, BOOK_SLUG)
		]);
		await insertAttempt(owner, { chunkId: book.chunkIds[0], bookId: book.id });
	});

	test.afterAll(async () => {
		await deleteUsers(owner.id, stranger.id);
	});

	for (const table of ['chunk_progress', 'book_progress'] as const) {
		test(`${table} stays private to its owner after the trigger writes it`, async () => {
			const own = await owner.client.from(table).select('user_id');
			expect(own.error, `${table} read failed: ${own.error?.message}`).toBeNull();
			expect(own.data, `the trigger should have populated ${table}`).toEqual([
				{ user_id: owner.id }
			]);

			// A row demonstrably exists, so these are real misses, not empty tables.
			for (const result of [
				await stranger.client.from(table).select('*'),
				await stranger.client.from(table).select('*').eq('user_id', owner.id),
				await anon.from(table).select('*')
			]) {
				if (result.error) expect(result.error.code).toBe('42501');
				else expect(result.data ?? []).toEqual([]);
			}
		});

		test(`${table} refuses a client write after the trigger exists`, async () => {
			// The trigger is the sole writer: no insert/update/delete policy or grant.
			const insert = await owner.client.from(table).insert({
				user_id: owner.id,
				book_id: book.id,
				...(table === 'chunk_progress' && { chunk_id: book.chunkIds[1] })
			});
			expect(insert.error, `${table} accepted a client insert`).not.toBeNull();

			const update = await owner.client
				.from(table)
				.update({ book_id: book.id })
				.eq('user_id', owner.id)
				.select();
			if (!update.error) expect(update.data).toEqual([]);

			const remove = await owner.client.from(table).delete().eq('user_id', owner.id).select();
			if (!remove.error) expect(remove.data).toEqual([]);

			// And the trigger's value is still standing.
			const still = await owner.client.from(table).select('user_id');
			expect(still.data).toEqual([{ user_id: owner.id }]);
		});
	}
});
