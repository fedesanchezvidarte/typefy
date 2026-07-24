import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

/**
 * Keepalive (spec #7, ADR-0002/0003): a daily cron hits this endpoint to run a trivial
 * read, keeping the free-tier Supabase project inside its ~7-day inactivity window.
 *
 * Gated by a shared secret so it is not a public database-poking surface. Vercel Cron
 * sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is configured; any request
 * without the matching secret is rejected.
 */
export const GET: RequestHandler = async ({ request, locals }) => {
	const secret = env.CRON_SECRET;
	if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
		error(401, 'Unauthorized');
	}

	const { error: dbError } = await locals.supabase.from('books').select('id').limit(1);
	if (dbError) {
		error(500, 'Keepalive read failed');
	}

	return json({ ok: true, at: new Date().toISOString() });
};
