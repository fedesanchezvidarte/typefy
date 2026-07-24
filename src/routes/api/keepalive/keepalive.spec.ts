import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

/**
 * Keepalive endpoint tests (spec #7): "the keepalive endpoint returns success with the
 * correct secret and rejects requests without it". The Supabase client is mocked — no
 * real database call reaches a unit test (testing-patterns).
 */

const mocked = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: mocked.env }));

const SECRET = 'cron-secret';

/** Chainable stub for `locals.supabase.from('books').select('id').limit(1)`. */
function mockSupabase(result: { data: unknown; error: unknown }) {
	const from = vi.fn(() => ({
		select: vi.fn(() => ({
			limit: vi.fn(() => Promise.resolve(result))
		}))
	}));
	return { from };
}

function requestEvent(
	headers: Record<string, string>,
	result: { data: unknown; error: unknown } = { data: [{ id: 'book-id' }], error: null }
) {
	const supabase = mockSupabase(result);
	const event = {
		request: new Request('http://localhost/api/keepalive', { headers }),
		locals: { supabase }
	};
	// Only the two fields the handler touches are stubbed; the cast keeps the test
	// honest about the handler's own event type rather than a widened RequestEvent.
	return { event: event as unknown as Parameters<typeof GET>[0], supabase };
}

describe('GET /api/keepalive', () => {
	beforeEach(() => {
		mocked.env.CRON_SECRET = SECRET;
	});

	it('returns ok and reads a book when the request carries the correct secret', async () => {
		const { event, supabase } = requestEvent({ authorization: `Bearer ${SECRET}` });

		const response = await GET(event);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ ok: true });
		expect(supabase.from).toHaveBeenCalledWith('books');
	});

	it('rejects a request with no Authorization header', async () => {
		const { event, supabase } = requestEvent({});

		await expect(GET(event)).rejects.toMatchObject({ status: 401 });
		expect(supabase.from).not.toHaveBeenCalled();
	});

	it('rejects a request carrying the wrong secret', async () => {
		const { event, supabase } = requestEvent({ authorization: 'Bearer not-the-secret' });

		await expect(GET(event)).rejects.toMatchObject({ status: 401 });
		expect(supabase.from).not.toHaveBeenCalled();
	});

	it('rejects every request when CRON_SECRET is not configured', async () => {
		mocked.env.CRON_SECRET = undefined;
		const { event } = requestEvent({ authorization: 'Bearer ' });

		await expect(GET(event)).rejects.toMatchObject({ status: 401 });
	});

	it('fails with 500 when the keepalive read errors', async () => {
		const { event } = requestEvent(
			{ authorization: `Bearer ${SECRET}` },
			{ data: null, error: { message: 'connection refused' } }
		);

		await expect(GET(event)).rejects.toMatchObject({ status: 500 });
	});
});
