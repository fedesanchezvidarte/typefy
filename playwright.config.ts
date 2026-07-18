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
	forbidOnly: isCI,
	retries: isCI ? 2 : 0
});
