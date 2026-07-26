import { createBrowserClient } from '@supabase/ssr';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';

/**
 * The browser twin of the request-scoped client in `src/hooks.server.ts` (spec #12).
 *
 * This is the ONE module allowed to construct a Supabase client on the client side; every
 * consumer receives the client as an injected parameter (`lib-patterns`), which is why this
 * module is the single sanctioned exception to that rule.
 *
 * It deliberately lives outside `src/lib/server/`, which SvelteKit blocks from client import.
 * It must be reached only through a dynamic `import()`, so `@supabase/ssr` and
 * `@supabase/supabase-js` stay out of the entry bundle and guests pay nothing for a feature
 * they cannot use (Brief §1.6).
 *
 * **No unit test.** There is nothing to test: the function is a constructor over two
 * build-time-inlined `$env/static/public` values with no branch, no mapping and no error
 * path. A test could only assert that `createBrowserClient` was called with the constants it
 * was called with — tautological by the `testing-patterns` standard. Its real behaviour (that
 * the browser client picks up the same auth cookies `hooks.server.ts` wrote) is only
 * observable end-to-end, and is covered by the Playwright write-path tests.
 */
export function getBrowserSupabase(): SupabaseClient<Database> {
	// No `cookies` option: in a browser `@supabase/ssr` defaults its storage to
	// `document.cookie` with base64url encoding and its own chunking — precisely the format
	// `hooks.server.ts` already writes, so the session is shared without anything crossing
	// the SSR/CSR boundary in page data.
	//
	// No `cookieOptions.name` either: changing the storage key would desynchronise this
	// client from the server one.
	//
	// No caching layer here — `createBrowserClient` keeps its own module-level singleton
	// when it detects a browser (`isSingleton` defaults to `isBrowser()`), so repeated calls
	// already return the same instance.
	return createBrowserClient<Database>(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
