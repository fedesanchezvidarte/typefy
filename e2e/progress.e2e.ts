import { expect, test } from '@playwright/test';
import {
	anonClient,
	deleteUsers,
	epoch,
	isLocalStack,
	signUpUser,
	SUPABASE_URL,
	type AnyClient,
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

interface SeededBook {
	id: string;
	chunkCount: number;
	/** Chunk ids in `index` order. */
	chunkIds: string[];
}

/** Read the real seeded shape rather than assuming it (content is world-readable). */
async function readBook(anon: AnyClient, slug: string): Promise<SeededBook> {
	const book = await anon.from('books').select('id, chunk_count').eq('slug', slug).single();
	expect(
		book.error,
		`the local stack must be seeded (npm run db:reset): ${book.error?.message}`
	).toBeNull();

	const chunks = await anon
		.from('chunks')
		.select('id, index')
		.eq('book_id', book.data!.id)
		.order('index');
	expect(chunks.error, `reading chunks failed: ${chunks.error?.message}`).toBeNull();
	expect(chunks.data!.length, `${slug} should have ${book.data!.chunk_count} chunks`).toBe(
		book.data!.chunk_count
	);

	return {
		id: book.data!.id,
		chunkCount: book.data!.chunk_count,
		chunkIds: chunks.data!.map((c) => c.id)
	};
}

interface AttemptInput {
	chunkId: string;
	bookId: string;
	completed?: boolean;
	grossWpm?: number;
	accuracyRaw?: number;
	elapsedMs?: number;
	/** Client-supplied and informational only: no rollup rule may read it. */
	startedAt?: string;
}

/**
 * Insert one attempt as `user` and return the server clock it was stamped with. Every
 * rollup timestamp must equal this value, never the client-supplied `started_at`.
 */
async function insertAttempt(user: TestUser, input: AttemptInput): Promise<string> {
	const { data, error } = await user.client
		.from('chunk_attempts')
		.insert({
			user_id: user.id,
			chunk_id: input.chunkId,
			book_id: input.bookId,
			completed: input.completed ?? true,
			gross_wpm: input.grossWpm ?? 50,
			accuracy_raw: input.accuracyRaw ?? 0.9,
			elapsed_ms: input.elapsedMs ?? 30_000,
			started_at: input.startedAt ?? new Date().toISOString()
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
