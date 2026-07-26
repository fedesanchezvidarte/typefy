import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/database.types';

/**
 * Shared helpers for the database-level E2E specs (`rls.e2e.ts`, `progress.e2e.ts`).
 *
 * These specs talk to PostgREST/GoTrue directly with supabase-js and never open a page.
 * They live in the Playwright suite rather than in Vitest because the unit suite is
 * forbidden from touching a real database (testing-patterns); the E2E suite already runs
 * against a seeded local stack in CI.
 *
 * They create throwaway users, so every spec that uses them must guard on
 * {@link isLocalStack} and refuse to run against anything but a local stack.
 *
 * This file deliberately does NOT match Playwright's `**\/*.e2e.{ts,js}` testMatch glob:
 * it is a helper module, not a spec. Keep it that way.
 */

export const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const PUBLISHABLE_KEY =
	process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

/** Whether the configured Supabase is a local stack — the only place throwaway users may be created. */
export const isLocalStack = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(SUPABASE_URL);

export type AnyClient = SupabaseClient<Database>;

export function anonClient(): AnyClient {
	return createClient<Database>(SUPABASE_URL, PUBLISHABLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false }
	});
}

/**
 * The local secret key, used only to delete the throwaway users afterwards. It is
 * machine-specific, so it is read from the running stack rather than hardcoded; when it
 * cannot be read the tests still run and simply leave their users behind (a `db:reset`
 * clears them).
 */
export function localSecretKey(): string | null {
	if (process.env.SUPABASE_SECRET_KEY) return process.env.SUPABASE_SECRET_KEY;
	try {
		// Node >= 20 refuses to spawn a `.cmd` directly (EINVAL), so on Windows the CLI is
		// reached through cmd.exe. Without this the whole function silently returned null
		// there and every throwaway user was left behind.
		const [file, prefix] =
			process.platform === 'win32' ? ['cmd.exe', ['/c', 'npx']] : ['npx', [] as string[]];
		const status = execFileSync(file, [...prefix, 'supabase', 'status', '-o', 'json'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		const parsed: unknown = JSON.parse(status);
		const key = (parsed as Record<string, unknown>)?.SECRET_KEY;
		return typeof key === 'string' ? key : null;
	} catch {
		return null;
	}
}

export interface TestUser {
	client: AnyClient;
	id: string;
}

/**
 * Sign up a throwaway user against the local stack and return a client already carrying
 * its session. `prefix` only shapes the (unroutable) email address, to make stray rows
 * traceable back to the spec that made them.
 */
export async function signUpUser(prefix = 'e2e'): Promise<TestUser> {
	const client = anonClient();
	const { data, error } = await client.auth.signUp({
		email: `${prefix}-${randomUUID()}@typefy.test`,
		password: `Pw-${randomUUID()}`
	});
	expect(error, `sign-up failed: ${error?.message}`).toBeNull();
	expect(
		data.session,
		'local sign-up should return a session (confirmations disabled)'
	).not.toBeNull();
	expect(data.user).not.toBeNull();
	return { client, id: data.user!.id };
}

/**
 * Parse a `timestamptz` as returned by PostgREST into epoch milliseconds.
 *
 * Timestamps are compared by value, never by string: Postgres stores microseconds and
 * `Date.parse` truncates them, so two columns holding the same instant always agree here
 * even if their serialised text ever diverged. Fails loudly on null/unparseable input so
 * a missing timestamp is a test failure rather than a silent `NaN` comparison.
 */
export function epoch(value: string | null | undefined): number {
	expect(value, 'expected a timestamp, got null/undefined').not.toBeFalsy();
	const ms = Date.parse(value!);
	expect(Number.isNaN(ms), `unparseable timestamp: ${value}`).toBe(false);
	return ms;
}

/**
 * Delete throwaway auth users with the local secret key. Deleting the auth user cascades
 * to `profiles` and every progress row. A no-op when the key cannot be read.
 */
export async function deleteUsers(...ids: string[]): Promise<void> {
	const secret = localSecretKey();
	if (!secret) return;
	const admin = createClient<Database>(SUPABASE_URL, secret, {
		auth: { persistSession: false, autoRefreshToken: false }
	});
	await Promise.all(ids.map((id) => admin.auth.admin.deleteUser(id)));
}
