// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Request-scoped Supabase client (@supabase/ssr), bound to the request cookies. */
			supabase: SupabaseClient<Database>;
			/** Returns the session only if its JWT validates via getUser(); never trusts getSession() alone. */
			safeGetSession: () => Promise<{ session: Session | null; user: User | null }>;
		}
		// PageData.session is provided by a root layout load when auth lands (Phase 2a).
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
