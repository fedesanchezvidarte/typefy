import { getContext, setContext } from 'svelte';
import type { MetricsSnapshot } from '$lib/engine/metrics';

/**
 * The typing screen's **header center slot** (spec #45), and the seam that lets a route fill a
 * region of the shared `AppHeader` without the header knowing anything about typing.
 *
 * Why a context store rather than a prop or a snippet: `AppHeader` renders in the root layout,
 * ABOVE the page component that owns the live session, so nothing the page renders can reach it
 * by ordinary top-down flow. Context is the one channel that runs the right way (the layout
 * creates the store, a descendant writes it) and it is created per component tree, so it can
 * never leak between two concurrently-rendering requests the way a module-level `$state` would.
 *
 * **It is deliberately NOT the first paint.** During SSR the header renders before
 * `TypingSession`'s effect has run, so the slot would be empty exactly when the mode axis and
 * the page number must already be right (spec #24 §10). The load supplies those opening values
 * as `page.data.typingHeader`, and this store overlays live ones from mount on — see
 * `AppHeader.svelte`, which reads the seed and the store in that order.
 */
export interface TypingHeaderView {
	title: string;
	author: string;
	/** `null` for front matter, and for a book with no chapters — both legal (ADR-0017). */
	chapter: string | null;
	/** 1-based, matching the page navigator and `?page=N`. */
	current: number;
	total: number;
	pct: number;
	/** Live metrics, refreshed at word boundaries only; `null` until the first boundary. */
	live: MetricsSnapshot | null;
	zen: boolean;
	/** `null` before hydration — the seed renders the toggle, the session makes it work. */
	onToggleZen: (() => void) | null;
}

const KEY = Symbol('typing-header');

export class TypingHeaderStore {
	/**
	 * `$state.raw`: the view is replaced wholesale on every session change, never mutated
	 * field-by-field, so deep reactivity would cost proxying for nothing.
	 */
	view = $state.raw<TypingHeaderView | null>(null);
}

/** Called once, by the root layout, before `AppHeader` renders. */
export function provideTypingHeader(): TypingHeaderStore {
	const store = new TypingHeaderStore();
	setContext(KEY, store);
	return store;
}

/**
 * The store, or `null` when there is none — which is the ordinary case for a component test
 * that mounts a piece of the typing screen without the layout above it.
 */
export function useTypingHeader(): TypingHeaderStore | null {
	return getContext<TypingHeaderStore | undefined>(KEY) ?? null;
}
