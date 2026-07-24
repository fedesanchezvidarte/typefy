<script lang="ts">
	import { getLocale, locales, setLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/** When signed in, the choice is also persisted to the user's profile. */
		signedIn?: boolean;
	}

	let { signedIn = false }: Props = $props();

	const labels = {
		en: m.lang_label_en,
		es: m.lang_label_es
	};

	/**
	 * setLocale() writes the cookie and reloads. For a signed-in user we first persist the
	 * choice to profiles.locale so it follows them across devices (spec #7). A failed save
	 * is non-blocking — the cookie preference still applies.
	 */
	async function chooseLocale(locale: (typeof locales)[number]) {
		if (signedIn) {
			try {
				await fetch('/api/locale', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ locale })
				});
			} catch {
				// ignore: the cookie set by setLocale() below still records the choice
			}
		}
		setLocale(locale);
	}
</script>

<nav aria-label={m.language_switcher_label()}>
	<ul class="flex gap-2">
		{#each locales as locale (locale)}
			<li>
				<button
					type="button"
					class={[
						'rounded-md border px-3 py-1.5 text-sm transition-colors',
						getLocale() === locale
							? 'border-zinc-900 bg-zinc-900 font-semibold text-white'
							: 'border-zinc-300 hover:border-zinc-500'
					]}
					aria-current={getLocale() === locale ? 'true' : undefined}
					onclick={() => chooseLocale(locale)}
				>
					{labels[locale]()}
				</button>
			</li>
		{/each}
	</ul>
</nav>
