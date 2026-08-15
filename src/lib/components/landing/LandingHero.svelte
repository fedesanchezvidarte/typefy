<script lang="ts">
	import { untrack } from 'svelte';
	import { applySessionEvent, createSession, loadedChunks } from '$lib/engine/session';
	import type { SessionEvent, SessionState } from '$lib/engine/session';
	import type { TypeableText } from '$lib/types';
	import TypingSurface from '$lib/components/typing/TypingSurface.svelte';

	interface Props {
		book: TypeableText;
		/**
		 * Fired the instant the hero surface sees a real typing event (`char` or
		 * `backspace`) — never on chunk restarts. The landing page uses this to
		 * freeze its headline animation permanently for the page view (spec #30):
		 * the moment someone actually engages with the demo, the tail stops moving.
		 */
		onInteract?: () => void;
	}

	let { book, onInteract }: Props = $props();

	/*
	 * The landing hero IS a live typing surface (brief §5): a real page,
	 * already focused, responding on the first keystroke. It runs the same
	 * engine as the typing screen but shows no metrics and never reaches a
	 * summary — completing the final page loops back to the first. A demo
	 * that explains the product by being the product.
	 *
	 * `book.chunkCount` is read from the hero book rather than written as `1`:
	 * `getHeroBook` sets it, and hardcoding it here would fabricate a length the
	 * loop depends on. The hero is the one place a whole `TypeableText` is still
	 * legitimate (spec #18) — one chunk, no window, so the session can never
	 * enter `awaiting` and `activeChunk` is never null in practice. The guard
	 * below is the type-level statement of that, not a fallback with behaviour.
	 */
	let session = $state.raw<SessionState>(
		untrack(() => createSession(loadedChunks(book.chunks, book.chunkCount)))
	);

	function dispatch(event: SessionEvent) {
		if (event.type === 'char' || event.type === 'backspace') {
			onInteract?.();
		}
		let next = applySessionEvent(session, event);
		if (next.status === 'finished') {
			next = applySessionEvent(next, { type: 'restart-session' }); // loop, no summary
		}
		session = next;
	}
</script>

<div class="flex w-full justify-center" data-testid="landing-hero">
	{#if session.activeChunk}
		<TypingSurface
			text={session.activeChunk.text}
			display={session.activeChunk.display}
			typed={session.activeChunk.typed}
			cursor={session.activeChunk.cursor}
			passageKey={session.activeIndex}
			onChar={(char, timestamp) => dispatch({ type: 'char', char, timestamp })}
			onBackspace={(timestamp) => dispatch({ type: 'backspace', timestamp })}
			onRestartChunk={() => dispatch({ type: 'restart-chunk' })}
			visibleLines={5}
		/>
	{/if}
</div>
