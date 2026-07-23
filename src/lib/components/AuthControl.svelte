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
</script>

{#if user}
	<div class="flex items-center gap-3">
		<span class="text-sm text-zinc-600" data-testid="auth-identity">
			{m.auth_signed_in_as({ name: displayName })}
		</span>
		<form method="POST" action="/auth/signout">
			<input type="hidden" name="next" value={next} />
			<button
				type="submit"
				data-testid="auth-sign-out"
				class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
			>
				{m.auth_sign_out()}
			</button>
		</form>
	</div>
{:else}
	<form method="POST" action="/auth/signin">
		<input type="hidden" name="next" value={next} />
		<button
			type="submit"
			data-testid="auth-sign-in"
			class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
		>
			{m.auth_sign_in_google()}
		</button>
	</form>
{/if}
