import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.{ts,js}',
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
	retries: isCI ? 2 : 0
});
