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
	<!-- Two equal halves, sized to match the font and palette rows above them (spec #30 polish):
	     the segments read as a control, not as two words. Selected is the same accent hairline on
	     a sheet fill the other two groups use. -->
	<ul class="flex gap-2">
		{#each locales as locale (locale)}
			<li class="flex-1">
				<button
					type="button"
					class={[
						'w-full rounded-lg border px-3 py-2 text-[13px] tracking-wide transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
						getLocale() === locale
							? 'border-accent bg-sheet font-semibold text-fg'
							: 'border-border text-muted hover:text-fg'
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
