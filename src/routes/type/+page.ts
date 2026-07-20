import type { PageLoad } from './$types';
import { fixtureTexts } from '$lib/fixtures';

/**
 * Universal load: Phase 1 serves the hardcoded fixtures (spec #5). Phase 2 swaps
 * this for a Supabase read — consumers only ever see the `TypeableText` shape.
 */
export const load: PageLoad = () => {
	return { texts: fixtureTexts };
};
