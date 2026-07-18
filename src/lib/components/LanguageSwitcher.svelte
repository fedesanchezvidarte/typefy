<script lang="ts">
	import { getLocale, locales, setLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';

	const labels = {
		en: m.lang_label_en,
		es: m.lang_label_es
	};
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
					onclick={() => setLocale(locale)}
				>
					{labels[locale]()}
				</button>
			</li>
		{/each}
	</ul>
</nav>
