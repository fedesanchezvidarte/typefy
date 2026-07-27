<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { ATTEMPT_BUFFER_CAP } from '$lib/progress/buffer';
	import type { SessionSummary } from '$lib/engine/session';

	interface Props {
		summary: SessionSummary;
		onRestartSession: () => void;
		onPickAnother: () => void;
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

	let {
		summary,
		onRestartSession,
		onPickAnother,
		failedSaves,
		pendingSaves,
		signedIn,
		next
	}: Props = $props();

	// Floored, not rounded: a session with an error must never display as 100%.
	const accuracyPct = $derived(Math.floor(summary.overallAccuracy * 100));

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

	const primaryButtonClasses =
		'rounded-lg border border-border bg-sheet px-4 py-2.5 text-sm text-fg transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
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
		{m.summary_heading_passages({ count: summary.chunksCompleted })}
	</h1>
	<dl class="mt-7 mb-2 grid grid-cols-2 gap-6">
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
		<div>
			<dt class="mb-1 text-[13px] text-muted">{m.summary_passages()}</dt>
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
	<div class="flex flex-wrap gap-2.5">
		<button
			type="button"
			data-testid="summary-restart-session"
			class={primaryButtonClasses}
			onclick={onRestartSession}
		>
			{m.summary_type_again()}
		</button>
		<button
			type="button"
			data-testid="summary-pick-another"
			class={secondaryButtonClasses}
			onclick={onPickAnother}
		>
			{m.summary_back_to_library()}
		</button>
	</div>

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
