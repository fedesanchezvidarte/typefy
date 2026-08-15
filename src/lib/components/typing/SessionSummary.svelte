<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { ATTEMPT_BUFFER_CAP } from '$lib/progress/buffer';
	import type { SessionSummary } from '$lib/engine/session';

	interface Props {
		summary: SessionSummary;
		/**
		 * Passages whose insert did not save this session, for ANY reason (spec #12 §6). Stated
		 * once, quietly, here — never during typing, never as an alarm. Nothing renders at 0.
		 *
		 * **This is no longer the number to show as lost.** Spec #15 splits it: the
		 * `pendingSaves` subset was buffered and will be retried, so only the remainder is
		 * genuinely gone.
		 */
		failedSaves: number;
		/**
		 * The subset of `failedSaves` that failed transiently and was buffered (spec #15 §3).
		 * These passages are **pending, not lost** — a later drain will write them — so they
		 * get their own, gentler statement.
		 */
		pendingSaves: number;
		/** Guests see a prompt to sign in and save progress (spec #7); `next` returns them here. */
		signedIn: boolean;
		next: string;
	}

	let { summary, failedSaves, pendingSaves, signedIn, next }: Props = $props();

	/**
	 * Both figures are `number | null` since spec #24, and they are null TOGETHER: the engine
	 * makes it all-or-nothing on `everUnmeasured`, so a session containing any Zen time at all
	 * — even an instantaneous toggle that accrued no milliseconds — reports neither.
	 */
	const zen = $derived(summary.averageWpm === null || summary.overallAccuracy === null);

	// Floored, not rounded: a session with an error must never display as 100%. Null in Zen,
	// where there is no accuracy to floor — the tile that would have shown it is not rendered.
	const accuracyPct = $derived(
		summary.overallAccuracy === null ? null : Math.floor(summary.overallAccuracy * 100)
	);

	/**
	 * Passages that are actually lost: every failure minus the ones sitting in the buffer.
	 * Derived here rather than at the call site so `summary_save_failures` — whose wording now
	 * means *permanently* unsaved — can never be handed the total by accident.
	 */
	const lostSaves = $derived(failedSaves - pendingSaves);

	/**
	 * Whether either save notice has anything to say. Read only for spacing — the notice
	 * region itself renders unconditionally; see the region's own comment for why.
	 */
	const hasSaveNotice = $derived(pendingSaves > 0 || lostSaves > 0);

	/**
	 * What the guest prompt may honestly promise signing in will save.
	 *
	 * Clamped to the buffer cap, because that is the most this browser can be holding: past
	 * the cap `enqueue` evicts oldest-first, so a 60-passage session has 50 recoverable
	 * passages and the uncapped number would be a lie. Imported rather than written as `50`
	 * so raising the cap cannot leave this claim behind.
	 */
	const signInPromptCount = $derived(Math.min(summary.chunksCompleted, ATTEMPT_BUFFER_CAP));

	function formatDuration(ms: number): string {
		const totalSeconds = Math.round(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	}

	const secondaryButtonClasses =
		'rounded-lg border border-border bg-transparent px-4 py-2.5 text-sm text-muted transition-colors hover:border-accent hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
</script>

<!--
	tabindex="-1" + focus on mount: the typing surface unmounts when the session
	finishes, so focus is moved here instead of silently dying on <body>.
	No celebration (brief §2): a quiet reading of the numbers, nothing more.
-->
<section
	data-testid="session-summary"
	class="flex w-full max-w-[560px] flex-col gap-2 outline-none"
	tabindex="-1"
	aria-labelledby="session-summary-heading"
	{@attach (node) => {
		node.focus();
	}}
>
	<p class="text-xs tracking-[0.16em] text-muted uppercase">{m.summary_kicker()}</p>
	<!-- h1: when the summary shows, the typing screen's book-line h1 has unmounted. -->
	<h1 id="session-summary-heading" class="text-[28px] font-semibold tracking-[-0.02em]">
		{m.summary_heading_pages({ count: summary.chunksCompleted })}
	</h1>
	<dl class="mt-7 mb-2 grid grid-cols-2 gap-6">
		<!--
			THE TWO METRIC TILES ARE ABSENT, NOT EMPTY, after a session containing any Zen time
			(spec #24 §11). No em-dash, no placeholder, no dimmed zero: a tile that advertises the
			number Zen refused is worse than no tile.

			One guard for both because the two are null together — see `zen` in the script. The
			grid needs no change: it simply renders two tiles instead of four. Everything else on
			this summary — the kicker, the heading, Passages, TIME, the status region, the actions
			and the guest prompt — renders identically in both modes. Time is neither WPM nor
			accuracy, and §11 prohibits exactly two tiles; do not extend the omission to it.
		-->
		{#if summary.averageWpm !== null && summary.overallAccuracy !== null}
			<div>
				<dt class="mb-1 text-[13px] text-muted">{m.summary_average_speed()}</dt>
				<dd data-testid="summary-wpm" class="text-[34px] font-semibold tabular-nums">
					{Math.round(summary.averageWpm)}<span class="text-[15px] font-normal text-muted">
						{m.unit_wpm()}</span
					>
				</dd>
			</div>
			<div>
				<dt class="mb-1 text-[13px] text-muted">{m.summary_accuracy()}</dt>
				<dd data-testid="summary-accuracy" class="text-[34px] font-semibold tabular-nums">
					{accuracyPct}<span class="text-[15px] font-normal text-muted">%</span>
				</dd>
			</div>
		{/if}
		<div>
			<dt class="mb-1 text-[13px] text-muted">{m.summary_pages()}</dt>
			<dd data-testid="summary-chunks" class="text-[34px] font-semibold tabular-nums">
				{summary.chunksCompleted}
			</dd>
		</div>
		<div>
			<dt class="mb-1 text-[13px] text-muted">{m.summary_time()}</dt>
			<dd data-testid="summary-time" class="text-[34px] font-semibold tabular-nums">
				{formatDuration(summary.totalActiveMs)}
			</dd>
		</div>
	</dl>
	{#if zen}
		<!-- Why two figures are missing, said once and quietly. A line of prose in the same muted
		     register as the save notices — deliberately NOT a tile and NOT inside the `dl`, which
		     would make it the placeholder the omission exists to avoid. -->
		<p class="mb-2 text-sm text-muted" data-testid="summary-zen-note">{m.summary_zen_note()}</p>
	{/if}
	<!--
		Two statements, not error banners: same muted register as the rest of the summary.
		Wrapped so the 3-unit gap before the buttons is stated once however many of the two
		appear; each still guards itself, so neither ever renders at 0.

		**The wrapper is a `role="status"` region, and it renders UNCONDITIONALLY.** Both halves
		of that matter, and the earlier reasoning here — "not live regions, because they render
		with the summary, which takes focus on mount, so a screen reader reaches them in
		ordinary reading order" — was only ever true of failures that had already resolved.

		The last passage of a session is completed by the same keystroke that finishes it, so
		its `recordChunkAttempt` is still in flight when this component mounts and takes focus.
		Its outcome raises `pendingSaves`/`failedSaves` a network round-trip LATER — and offline,
		which is the exact condition these notices exist to report, that is always the case. So
		the notice is inserted into a subtree that already has focus, after the screen reader has
		read past this point: silently. Someone who cannot see the summary is told nothing about
		the passages that did not save, which is the one thing the notices are for (WCAG 2.2
		SC 4.1.3, Status Messages).

		Hence `role="status"` (polite + atomic, so a late second notice re-reads the pair as one
		statement). And hence unconditional: a live region must already be in the accessibility
		tree BEFORE content enters it, or the insertion that creates the region is not announced
		at all — guarding the wrapper with the counts would rebuild the region together with its
		content and reproduce the silence it is here to fix.

		Nothing is announced twice. When a count HAS settled before mount, region and content
		arrive together, which screen readers correctly treat as initial content and read in
		ordinary reading order — exactly what the original comment wanted, now true by
		construction rather than by assumption. Empty, the region renders nothing and takes no
		space; only the spacing below it is conditional.
	-->
	<div role="status" class={['flex flex-col gap-2', hasSaveNotice && 'mb-3']}>
		{#if pendingSaves > 0}
			<!-- Pending, not lost: buffered and waiting for connectivity to return. Read
			     first because it is the better news and the more common case. -->
			<p class="text-sm text-muted" data-testid="summary-save-pending">
				{m.summary_save_pending({ count: pendingSaves })}
			</p>
		{/if}
		{#if lostSaves > 0}
			<!-- Genuinely lost: a permanently refused write is never buffered and never
			     retried. `lostSaves`, NOT `failedSaves` — the message kept its name and its
			     `count` signature when its meaning narrowed, so passing the total would
			     still type-check and still render, silently reporting pending passages as
			     discarded. -->
			<p class="text-sm text-muted" data-testid="summary-save-failures">
				{m.summary_save_failures({ count: lostSaves })}
			</p>
		{/if}
	</div>
	<!-- No actions (spec #45). The summary REPORTS and nothing more: restarting a page or
	     picking another book were removed from the typing flow entirely, and the header is the
	     way onward from here. Resetting a book's stored progress is a different thing again,
	     and it belongs on the book detail screen behind a confirmation. -->

	{#if !signedIn}
		<!-- Guests only: the one place progress-saving is surfaced (the typing surface stays clean).
		     The prompt can now name what signing in actually recovers, because spec #15 buffered
		     those passages instead of discarding them — the count is the promise, and the drain
		     on the next layout mount is what keeps it. -->
		<form
			method="POST"
			action="/auth/signin"
			data-testid="summary-sign-in-prompt"
			class="mt-6 flex flex-wrap items-center gap-3.5 border-t border-border pt-5"
		>
			<input type="hidden" name="next" value={next} />
			<span class="text-sm text-muted">
				<!-- The countless variant is kept for exactly one case: nothing was completed, so
				     the count-aware wording ("save the 0 passages you just typed") has no honest
				     reading. It is reachable — the summary also renders after a session that was
				     restarted before any passage finished. -->
				{signInPromptCount > 0
					? m.summary_sign_in_prompt_count({ count: signInPromptCount })
					: m.summary_sign_in_prompt()}
			</span>
			<button type="submit" class={secondaryButtonClasses} data-testid="summary-sign-in">
				{m.auth_sign_in_google()}
			</button>
		</form>
	{/if}
</section>
