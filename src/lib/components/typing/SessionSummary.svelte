<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { SessionSummary } from '$lib/engine/session';

	interface Props {
		summary: SessionSummary;
		onRestartSession: () => void;
		onPickAnother: () => void;
		/** Guests see a prompt to sign in and save progress (spec #7); `next` returns them here. */
		signedIn: boolean;
		next: string;
	}

	let { summary, onRestartSession, onPickAnother, signedIn, next }: Props = $props();

	// Floored, not rounded: a session with an error must never display as 100%.
	const accuracyPct = $derived(Math.floor(summary.overallAccuracy * 100));

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
		<!-- Guests only: the one place progress-saving is surfaced (the typing surface stays clean). -->
		<form
			method="POST"
			action="/auth/signin"
			data-testid="summary-sign-in-prompt"
			class="mt-6 flex flex-wrap items-center gap-3.5 border-t border-border pt-5"
		>
			<input type="hidden" name="next" value={next} />
			<span class="text-sm text-muted">{m.summary_sign_in_prompt()}</span>
			<button type="submit" class={secondaryButtonClasses} data-testid="summary-sign-in">
				{m.auth_sign_in_google()}
			</button>
		</form>
	{/if}
</section>
