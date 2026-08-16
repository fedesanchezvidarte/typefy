import { getContext, setContext } from 'svelte';

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
 * `TypingSession`'s effect has run, so the slot would be empty on the server. The load supplies
 * the opening values as `page.data.typingHeader`, and this store overlays live ones from mount
 * on — see `AppHeader.svelte`, which reads the seed and the store in that order.
 *
 * **Spec #50 narrowed this to identity.** It used to carry the page number, the percentage, live
 * metrics, the mode axis and the toggle's callback, because the whole of the typing screen's
 * chrome lived up here. All of that moved into `TypingSession`'s own bottom row, and three things
 * fell out with it:
 *
 * - `onToggleZen: (() => void) | null` is gone. The toggle lives beside the function that drives
 *   it now, so there is no longer a state where the control is painted but inert.
 * - Spec #24 §10's "no metrics, not even for one frame" no longer depends on this seed at all.
 *   `TypingSession` is server-rendered with the `mode` prop straight from the load, so the bottom
 *   row paints in the right state on the server by construction.
 * - The store's writer no longer re-fires on every keystroke to push a percentage upward.
 */
export interface TypingHeaderView {
	title: string;
	/** `null` for front matter, and for a book with no chapters — both legal (ADR-0017). */
	chapter: string | null;
	/** The book's slug — the title renders as a link back to `/books/[slug]`. */
	slug: string;
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
