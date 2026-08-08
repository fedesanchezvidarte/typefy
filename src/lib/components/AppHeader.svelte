<script lang="ts">
	import { BookOpen } from '@lucide/svelte';
	import type { User } from '@supabase/supabase-js';
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { FontId } from '$lib/theme/fonts';
	import type { PaletteId } from '$lib/theme/palettes';
	import AccountMenu from './AccountMenu.svelte';
	import PencilPanel from './theme/PencilPanel.svelte';

	interface Props {
		user: User | null;
		palette: PaletteId | null;
		font: FontId | null;
	}

	let { user, palette, font }: Props = $props();

	// Same "return to where they were" pattern the old AuthControl guest branch used.
	const next = $derived(page.url.pathname + page.url.search);
</script>

<!-- Sticky, blurred over the page background (spec #9). Phase 5a (spec #30 §2) narrows the
     bar to exactly three controls: the wordmark, and a trailing cluster of the library link,
     the pencil (theme/language) trigger, and the avatar/account menu — or, signed out, a
     single Sign-in button in the avatar's position. Theme axis switchers now live inside
     PencilPanel, not in this row. -->
<header
	class="sticky top-0 z-20 flex items-center justify-between border-b border-border px-4 py-3 backdrop-blur-[10px] sm:px-6"
	style="background: color-mix(in srgb, var(--bg) 86%, transparent);"
>
	<a
		href={resolve(localizeHref('/') as Pathname)}
		class="flex items-center rounded px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		data-testid="wordmark"
	>
		<span class="text-[21px] font-semibold tracking-[-0.03em] text-fg"
			>{m.app_name().toLowerCase()}</span
		>
		<span
			class="ml-[3px] inline-block h-[19px] w-[3px] translate-y-[2px] rounded-[1px] bg-accent"
			aria-hidden="true"
		></span>
	</a>

	<div class="flex items-center gap-1 px-1">
		<a
			href={resolve(localizeHref('/type') as Pathname)}
			data-testid="nav-library"
			class="icon-trigger"
			aria-label={m.header_library()}
			title={m.header_library()}
		>
			<BookOpen size={20} strokeWidth={1.75} aria-hidden="true" />
		</a>

		<PencilPanel {palette} {font} signedIn={!!user} />

		{#if user}
			<AccountMenu {user} />
		{:else}
			<form method="POST" action="/auth/signin">
				<input type="hidden" name="next" value={next} />
				<button type="submit" data-testid="auth-sign-in" class="signin-button">
					<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
						<path
							fill="#4285F4"
							d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62Z"
						/>
						<path
							fill="#34A853"
							d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18Z"
						/>
						<path
							fill="#FBBC05"
							d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33Z"
						/>
						<path
							fill="#EA4335"
							d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58Z"
						/>
					</svg>
					{m.auth_sign_in_google()}
				</button>
			</form>
		{/if}
	</div>
</header>

<style>
	.icon-trigger {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 8px;
		color: var(--fg);
		cursor: pointer;
	}

	.icon-trigger:hover {
		background: color-mix(in srgb, var(--fg) 8%, transparent);
	}

	.icon-trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.signin-button {
		display: flex;
		align-items: center;
		gap: 8px;
		border-radius: 8px;
		border: 1px solid var(--border);
		padding: 6px 12px;
		font-size: 13px;
		color: var(--fg);
		cursor: pointer;
	}

	.signin-button:hover {
		border-color: var(--accent);
	}

	.signin-button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
