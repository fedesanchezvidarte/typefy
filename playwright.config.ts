import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.{ts,js}',
	// Retire probe books left behind by a run that never reached its teardown, so every run
	// starts from the seeded catalog regardless of how the last one ended. See the module.
	globalSetup: './e2e/support/global-setup.ts',
	// adapter-vercel's build output requires symlinks that Windows blocks by default,
	// so local runs use the dev server; CI (Linux) exercises the production build.
	webServer: isCI
		? { command: 'npm run build && npm run preview', port: 4173 }
		: { command: 'npm run dev', port: 5173, reuseExistingServer: true },
	// Explicit rather than inferred from `webServer.port` (spec #12): the authenticated
	// fixture reads it to scope its session cookies to the app's host, so the fixture and
	// the specs share one source of truth instead of each hardcoding a port.
	use: { baseURL: isCI ? 'http://localhost:4173' : 'http://localhost:5173' },
	forbidOnly: isCI,
	retries: isCI ? 2 : 0,
	// CI needs a report file to upload as an artifact (with `--trace on-first-retry`, the
	// HTML report is what surfaces a failure's trace at all); local runs keep the default
	// terminal reporter, no report directory written.
	reporter: isCI ? 'html' : 'list',
	/**
	 * One worker, everywhere. Not a performance concession — a correctness one.
	 *
	 * Every spec here shares ONE Postgres. Playwright isolates browsers, not databases, so
	 * files running on separate workers interleave their arrangement and teardown against the
	 * same global rows, and several specs assert on state that is global by nature:
	 * `typing.e2e.ts` pins the catalog grid to exactly the seeded fixtures, `resume-rpc.e2e.ts`
	 * pins `books_featured_per_language_idx` by taking the one featured-English slot, and
	 * `windowed-reading.e2e.ts` publishes probe books and features one for the landing hero.
	 * Run in parallel, those three fail each other in whatever order they happen to interleave
	 * — an extra card in the grid, a featured slot already taken — and the failure lands in the
	 * file that was merely READING the state rather than the one that wrote it, which is about
	 * the least debuggable shape a suite can have.
	 *
	 * Per-file cleanup does not fix it and cannot: the window between one file publishing a
	 * book and retiring it is exactly when another file is counting books. Serialising is the
	 * fix that matches what the fixtures actually are. The whole suite runs in ~2 minutes.
	 */
	workers: 1
});
