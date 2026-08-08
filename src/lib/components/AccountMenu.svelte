<script lang="ts">
	import type { User } from '@supabase/supabase-js';
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import RibbonPanel from './theme/RibbonPanel.svelte';

	/**
	 * Signed-in-only avatar trigger + ribbon panel (Phase 5a, spec #30 §2): name/email header,
	 * a Profile link, and the sign-out form relocated here from the now-deleted
	 * `AuthControl.svelte` — `data-testid="auth-sign-out"` is preserved so existing E2E
	 * selectors still resolve once QA opens the panel first.
	 */
	interface Props {
		user: User;
	}

	let { user }: Props = $props();

	let open = $state(false);
	let triggerEl = $state<HTMLButtonElement | null>(null);

	// Same "return to where they were" pattern AuthControl used for sign-out.
	const next = $derived(page.url.pathname + page.url.search);

	const displayName = $derived(
		user.user_metadata?.full_name ?? user.user_metadata?.name ?? user.email ?? ''
	);
	const avatarUrl = $derived(user.user_metadata?.avatar_url as string | undefined);
	// First-initial fallback (Google OAuth identities always carry a name or email).
	const initial = $derived((displayName || user.email || '?').trim().charAt(0).toUpperCase());
</script>

<div class="trigger-wrap">
	<button
		type="button"
		bind:this={triggerEl}
		class="avatar-trigger"
		data-testid="avatar-trigger"
		aria-label={m.header_avatar_aria_label()}
		aria-expanded={open}
		aria-haspopup="true"
		title={m.header_avatar_aria_label()}
		onclick={() => (open = !open)}
	>
		{#if avatarUrl}
			<img src={avatarUrl} alt="" class="avatar-img" />
		{:else}
			<span class="avatar-fallback" aria-hidden="true">{initial}</span>
		{/if}
	</button>

	<RibbonPanel
		bind:open
		{triggerEl}
		width="min(240px, calc(100vw - 32px))"
		label={m.header_avatar_aria_label()}
	>
		<div class="flex flex-col gap-3">
			<div class="account-header">
				<p class="account-name">{displayName}</p>
				{#if user.email}
					<p class="account-email" data-testid="account-email">{user.email}</p>
				{/if}
			</div>
			<nav class="flex flex-col gap-0.5" aria-label={m.header_avatar_aria_label()}>
				<a
					href={resolve(localizeHref('/profile') as Pathname)}
					data-testid="account-profile-link"
					class="menu-item">{m.profile_heading()}</a
				>
				<form method="POST" action="/auth/signout">
					<input type="hidden" name="next" value={next} />
					<button type="submit" data-testid="auth-sign-out" class="menu-item menu-item-button">
						{m.auth_sign_out()}
					</button>
				</form>
			</nav>
		</div>
	</RibbonPanel>
</div>

<style>
	/* Same header-edge anchoring as PencilPanel — see the comment there. */
	.trigger-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		align-self: stretch;
		margin-block: calc(-1 * var(--header-pad-y, 0px));
		padding-block: var(--header-pad-y, 0px);
	}

	.avatar-trigger {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		cursor: pointer;
		overflow: hidden;
	}

	.avatar-trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: 50%;
	}

	.avatar-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		border-radius: 50%;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 22%, var(--sheet));
	}

	.account-header {
		padding-bottom: 8px;
		border-bottom: 1px solid var(--border);
	}

	.account-name {
		font-size: 14px;
		font-weight: 600;
		color: var(--fg);
	}

	.account-email {
		margin-top: 2px;
		font-size: 12px;
		color: var(--muted);
	}

	.menu-item {
		display: block;
		width: 100%;
		border-radius: 6px;
		padding: 7px 8px;
		text-align: left;
		font-size: 13px;
		color: var(--fg);
		cursor: pointer;
	}

	.menu-item:hover {
		background: color-mix(in srgb, var(--fg) 8%, transparent);
	}

	.menu-item:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.menu-item-button {
		font-family: inherit;
	}
</style>
