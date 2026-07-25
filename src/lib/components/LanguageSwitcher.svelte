<script lang="ts">
	import { getLocale, locales, setLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/** When signed in, the choice is also persisted to the user's profile. */
		signedIn?: boolean;
	}

	let { signedIn = false }: Props = $props();

	// Compact EN/ES segments (spec #9 header); the accessible name stays the
	// full language name via aria-label.
	const labels = {
		en: { short: m.lang_short_en, full: m.lang_label_en },
		es: { short: m.lang_short_es, full: m.lang_label_es }
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
	<ul class="flex gap-0.5">
		{#each locales as locale (locale)}
			<li>
				<button
					type="button"
					class={[
						'rounded-md px-2 py-1 text-xs tracking-wide transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
						getLocale() === locale ? 'bg-fg font-semibold text-bg' : 'text-muted hover:text-fg'
					]}
					aria-label={labels[locale].full()}
					aria-current={getLocale() === locale ? 'true' : undefined}
					onclick={() => chooseLocale(locale)}
				>
					{labels[locale].short()}
				</button>
			</li>
		{/each}
	</ul>
</nav>
