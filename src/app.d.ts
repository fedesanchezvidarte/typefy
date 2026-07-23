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
		// Provided by the root +layout.server.ts. Optional so page loads need not return
		// them; components read page.data.user to tailor guest vs. signed-in behaviour.
		interface PageData {
			session?: Session | null;
			user?: User | null;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
