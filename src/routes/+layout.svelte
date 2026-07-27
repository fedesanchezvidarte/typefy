<script lang="ts">
	import { onMount } from 'svelte';
	import type { Pathname } from '$app/types';
	import type { LayoutData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import AppHeader from '$lib/components/AppHeader.svelte';
	// Statically importable because all three are Supabase-free (spec #15 §2/§4). The
	// `@supabase/*` chunk is reached only through `drainOnce`'s own `await import()`, which
	// runs only once a trigger has already decided there is something to drain — so the root
	// layout can own these triggers without putting Supabase in every page's entry graph.
	import { ATTEMPT_BUFFER_KEY, dropForUser, readAll } from '$lib/progress/buffer';
	import { getAttemptStorage } from '$lib/progress/storage';
	import { drainOnce } from '$lib/progress/drain-once';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	/**
	 * Sign-out and attribution hygiene (spec #15 §5). When no user is present, every
	 * *signed-in-authored* entry is dropped and every *guest-authored* one is kept — those are
	 * not anybody's yet, and they are precisely what the summary's sign-in prompt promises to
	 * recover.
	 *
	 * Deliberately reactive on `data.user` rather than bolted onto `/auth/signout`: it then
	 * covers sign-out, session expiry and any other transition to guest in one rule, whether
	 * that arrives as a full page load or a client-side navigation. Synchronous, idempotent,
	 * and it calls **no** `invalidateAll()` — which is what keeps it loop-free, since
	 * invalidating is exactly what would re-fire it.
	 *
	 * Two independent SSR guards: `$effect` never runs on the server, and `getAttemptStorage`
	 * returns `null` there anyway (as it does in private mode or with storage disabled), where
	 * `dropForUser` is a no-op.
	 */
	$effect(() => {
		if (data.user) return;
		dropForUser(getAttemptStorage(ATTEMPT_BUFFER_KEY), '*', Date.now());
	});

	/**
	 * The drain trigger for both "a guest just signed in / the app reopened with a session"
	 * and "connectivity came back" (spec #15 §4).
	 *
	 * The `readAll(...).length === 0` early return is the load-bearing line: it is a
	 * synchronous `localStorage` read, so a guest — or the overwhelmingly common signed-in
	 * user with an empty buffer — never reaches `drainOnce` and therefore never fetches the
	 * Supabase chunk. **The 2b guest bundle guarantee depends on this staying synchronous.**
	 *
	 * `invalidateAll()` only when the drain actually wrote something: a backfill changes the
	 * rollup-derived figures already on screen (the library card's percentage, the typing
	 * screen's), and nothing else would refresh them. `drainOnce` reports that rather than
	 * deciding it, precisely so this trigger can invalidate while the in-session one does not
	 * (spec §11).
	 */
	async function maybeDrain() {
		const userId = data.user?.id;
		if (!userId) return;
		if (readAll(getAttemptStorage(ATTEMPT_BUFFER_KEY), Date.now()).length === 0) return;

		const result = await drainOnce(userId);
		if (result && result.written > 0) await invalidateAll();
	}

	/**
	 * `onMount`, and emphatically **not** an `$effect`. An effect reading `data.user` would be
	 * re-fired by the `invalidateAll()` above (it replaces `data`), giving drain → invalidate →
	 * drain; with a persistently failing write that spins forever. `onMount` runs once per full
	 * page load and is not re-run by invalidation, which is what breaks the cycle. **Do not
	 * "simplify" this into an `$effect`.**
	 *
	 * A guest who signs in arrives back through a full page load (the OAuth callback), so mount
	 * is the right and sufficient hook for the conversion case.
	 */
	onMount(() => {
		void maybeDrain();
		window.addEventListener('online', maybeDrain);
		return () => window.removeEventListener('online', maybeDrain);
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<AppHeader user={data.user} palette={data.palette} font={data.font} />
{@render children()}

<div style="display:none">
	{#each locales as locale (locale)}
		<a href={resolve(localizeHref(page.url.pathname, { locale }) as Pathname)}>{locale}</a>
	{/each}
</div>
