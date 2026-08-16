<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import { clearBookPageState, PAGE_STATE_KEY } from '$lib/progress/page-state';
	import { getAttemptStorage } from '$lib/progress/storage';

	interface Props {
		/** The book's uuid — what page-state is keyed by, and what the action returns. */
		bookId: string;
	}

	let { bookId }: Props = $props();

	/**
	 * Step two is showing. Local, per-visit, and deliberately not in the URL or in `page.state`:
	 * a half-opened confirmation is not a place you should be able to link someone to.
	 */
	let confirming = $state(false);

	/**
	 * The closed-state trigger, so dismissing can hand focus back to it rather than to `<body>` —
	 * the same "never strand a keyboard user" rule the typing screen's toggles follow. Instance
	 * state, not module state: two of these on one page must not share a reference.
	 */
	let resetButton = $state<HTMLButtonElement | null>(null);

	function open() {
		confirming = true;
	}

	/** Closes, and returns focus once the trigger is back in the DOM. */
	function close() {
		confirming = false;
		queueMicrotask(() => resetButton?.focus());
	}
</script>

<!--
	The progress reset (spec #51 §5/§6), inside `Your progress` — adjacent to the statement of
	exactly what it destroys, and rendered by the parent only when there IS progress to reset.

	**Two-step inline, not a modal.** The app has no dialog anywhere — no `<dialog>`, no
	`role="dialog"` — so a modal would introduce a whole interaction pattern (focus trap, Escape,
	backdrop, return focus) for one button. Two steps already gate the accident: nothing is written
	on the first click, and the second click is on a control that did not exist a moment earlier,
	so it cannot be muscle memory.

	Type-to-confirm was rejected as over-gating. It belongs on operations that destroy data the user
	cannot recreate; here the typing history survives and the progress is re-earnable by typing.
-->
<div class="reset">
	{#if confirming}
		<!--
			`role="group"` with a label rather than an alert: the text is a question the user just
			asked for by clicking, not an interruption, and an assertive live region would talk over
			a screen reader mid-sentence. Focus moving to Cancel is what announces it.
		-->
		<div class="confirm" role="group" aria-label={m.book_detail_reset_confirm()}>
			<p class="prompt">{m.book_detail_reset_confirm()}</p>
			<div class="actions">
				<form
					method="POST"
					action="?/reset"
					use:enhance={() => {
						return async ({ update }) => {
							// The LOCAL half of the reset (spec §8). The server cannot reach
							// `localStorage`, so this browser drops this book's half-typed drafts —
							// "start this book over" and "here is the paragraph you were halfway
							// through last week" contradict each other.
							//
							// Best-effort and per-browser, exactly like the attempt buffer: a reset
							// performed on a phone cannot clear a laptop's drafts. The COUNTING is
							// made correct everywhere by the reset-aware rollup trigger, not by this.
							clearBookPageState(getAttemptStorage(PAGE_STATE_KEY), bookId, Date.now());
							// Re-runs the load, so the bar re-renders at zero and this whole
							// component disappears with it — there is no longer progress to reset.
							await update();
							confirming = false;
						};
					}}
				>
					<button type="submit" class="danger" data-testid="book-detail-reset-confirm">
						{m.book_detail_reset()}
					</button>
				</form>
				<button
					type="button"
					class="quiet"
					data-testid="book-detail-reset-cancel"
					onclick={close}
					{@attach (node) => {
						// Focus starts on CANCEL, not on the destructive control: a stray Enter after
						// the first click must not complete the action it opened.
						node.focus();
					}}
				>
					{m.book_detail_reset_cancel()}
				</button>
			</div>
		</div>
	{:else}
		<button
			type="button"
			class="quiet"
			data-testid="book-detail-reset"
			bind:this={resetButton}
			onclick={open}
		>
			{m.book_detail_reset()}
		</button>
	{/if}
</div>

<!--
	Escape closes the confirmation, matching every other dismissible surface in the app. Bound on
	the window rather than the container because focus is inside a nested `<form>`, and a keydown
	there would not reach a handler on the wrapper without bubbling assumptions.
-->
<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && confirming) close();
	}}
/>

<style>
	.reset {
		margin-top: 10px;
	}

	.confirm {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}

	.prompt {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.quiet,
	.danger {
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 4px 9px;
		font-size: 13px;
		cursor: pointer;
		transition:
			color 0.15s ease,
			border-color 0.15s ease;
	}

	.quiet {
		color: var(--muted);
	}

	.quiet:hover {
		color: var(--fg);
	}

	/*
	 * The one place `--error` is used as a control colour rather than as a character state. It is
	 * the app's only destructive action, and it is the second step of two — the affordance should
	 * look different from the button that opened it, or the two clicks read as one.
	 */
	.danger {
		border-color: var(--border);
		color: var(--error);
	}

	.danger:hover {
		border-color: var(--error);
	}

	.quiet:focus-visible,
	.danger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
