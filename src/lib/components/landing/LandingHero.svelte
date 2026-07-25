<script lang="ts">
	import { untrack } from 'svelte';
	import { applySessionEvent, createSession } from '$lib/engine/session';
	import type { SessionEvent, SessionState } from '$lib/engine/session';
	import type { TypeableText } from '$lib/types';
	import TypingSurface from '$lib/components/typing/TypingSurface.svelte';

	interface Props {
		book: TypeableText;
	}

	let { book }: Props = $props();

	/*
	 * The landing hero IS a live typing surface (brief §5): a real passage,
	 * already focused, responding on the first keystroke. It runs the same
	 * engine as the typing screen but shows no metrics and never reaches a
	 * summary — completing the final passage loops back to the first. A demo
	 * that explains the product by being the product.
	 */
	let session = $state.raw<SessionState>(untrack(() => createSession(book)));

	function dispatch(event: SessionEvent) {
		let next = applySessionEvent(session, event);
		if (next.finished) {
			next = applySessionEvent(next, { type: 'restart-session' }); // loop, no summary
		}
		session = next;
	}
</script>

<div class="flex w-full justify-center" data-testid="landing-hero">
	<TypingSurface
		text={session.activeChunk.text}
		display={session.activeChunk.display}
		cursor={session.activeChunk.cursor}
		passageKey={session.activeIndex}
		onChar={(char, timestamp) => dispatch({ type: 'char', char, timestamp })}
		onBackspace={(timestamp) => dispatch({ type: 'backspace', timestamp })}
		onRestartChunk={() => dispatch({ type: 'restart-chunk' })}
	/>
</div>
