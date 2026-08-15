<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import TypingSession from './TypingSession.svelte';
	import TypingHeaderSlot from './TypingHeaderSlot.svelte';
	import { provideTypingHeader } from './typing-header.svelte';

	/**
	 * **Test harness, not production code.** It stands in for the root layout, which is the
	 * only thing that provides the typing header's context store and the only place the header
	 * slot renders (spec #45).
	 *
	 * Without it, `TypingSession.svelte.spec.ts` would mount a session whose page number,
	 * percentage, metrics and Zen toggle have nowhere to go — the chrome those tests are about
	 * lives in `AppHeader` now. Mounting the real header instead would drag in `page.data`, the
	 * account menu and the theme panel for no gain, so this reproduces exactly the two things
	 * the layout contributes: the store, and a slot to render it into.
	 */
	let props: ComponentProps<typeof TypingSession> = $props();

	const store = provideTypingHeader();
</script>

{#if store.view}
	<TypingHeaderSlot view={store.view} />
{/if}
<TypingSession {...props} />
