import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import LanguageSwitcher from './LanguageSwitcher.svelte';

describe('LanguageSwitcher.svelte', () => {
	it('renders one button per supported UI locale', async () => {
		render(LanguageSwitcher);

		await expect.element(page.getByRole('button', { name: 'English' })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Español' })).toBeInTheDocument();
	});
});
