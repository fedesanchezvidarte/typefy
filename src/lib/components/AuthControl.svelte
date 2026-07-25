<script lang="ts">
	import type { User } from '@supabase/supabase-js';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		user: User | null;
	}

	let { user }: Props = $props();

	// Return the user to the exact page (and locale) they were on after sign-in/out.
	const next = $derived(page.url.pathname + page.url.search);

	const displayName = $derived(
		user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? user?.email ?? ''
	);

	const buttonClasses =
		'rounded-lg border border-border bg-transparent px-3 py-1.5 text-[13px] text-fg transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
</script>

{#if user}
	<div class="flex items-center gap-3">
		<span class="hidden text-[13px] text-muted sm:inline" data-testid="auth-identity">
			{m.auth_signed_in_as({ name: displayName })}
		</span>
		<form method="POST" action="/auth/signout">
			<input type="hidden" name="next" value={next} />
			<button type="submit" data-testid="auth-sign-out" class={buttonClasses}>
				{m.auth_sign_out()}
			</button>
		</form>
	</div>
{:else}
	<form method="POST" action="/auth/signin">
		<input type="hidden" name="next" value={next} />
		<button type="submit" data-testid="auth-sign-in" class={buttonClasses}>
			{m.auth_sign_in_google()}
		</button>
	</form>
{/if}
