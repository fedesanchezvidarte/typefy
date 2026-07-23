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

	function formatAccuracy(accuracy: number): string {
		return `${(accuracy * 100).toFixed(1)}%`;
	}

	function formatDuration(ms: number): string {
		const totalSeconds = Math.round(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	}

	const buttonClasses =
		'rounded-md border border-zinc-300 px-4 py-2 transition-colors hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900';
</script>

<!--
	tabindex="-1" + focus on mount: the typing surface unmounts when the session
	finishes, so focus is moved here instead of silently dying on <body>.
-->
<section
	data-testid="session-summary"
	class="flex w-full max-w-2xl flex-col gap-6 outline-none"
	tabindex="-1"
	aria-labelledby="session-summary-heading"
	{@attach (node) => {
		node.focus();
	}}
>
	<h2 id="session-summary-heading" class="text-2xl font-semibold">{m.summary_heading()}</h2>
	<dl class="grid grid-cols-2 gap-4">
		<div>
			<dt class="text-sm text-zinc-500">{m.summary_average_wpm()}</dt>
			<dd data-testid="summary-wpm" class="text-3xl font-bold tabular-nums">
				{Math.round(summary.averageWpm)}
			</dd>
		</div>
		<div>
			<dt class="text-sm text-zinc-500">{m.summary_overall_accuracy()}</dt>
			<dd data-testid="summary-accuracy" class="text-3xl font-bold tabular-nums">
				{formatAccuracy(summary.overallAccuracy)}
			</dd>
		</div>
		<div>
			<dt class="text-sm text-zinc-500">{m.summary_chunks_completed()}</dt>
			<dd data-testid="summary-chunks" class="text-3xl font-bold tabular-nums">
				{summary.chunksCompleted}
			</dd>
		</div>
		<div>
			<dt class="text-sm text-zinc-500">{m.summary_total_time()}</dt>
			<dd data-testid="summary-time" class="text-3xl font-bold tabular-nums">
				{formatDuration(summary.totalActiveMs)}
			</dd>
		</div>
	</dl>
	<div class="flex flex-wrap gap-3">
		<button
			type="button"
			data-testid="summary-restart-session"
			class={buttonClasses}
			onclick={onRestartSession}
		>
			{m.typing_restart_session()}
		</button>
		<button
			type="button"
			data-testid="summary-pick-another"
			class={buttonClasses}
			onclick={onPickAnother}
		>
			{m.summary_pick_another()}
		</button>
	</div>

	{#if !signedIn}
		<!-- Guests only: the one place progress-saving is surfaced (the typing surface stays clean). -->
		<form
			method="POST"
			action="/auth/signin"
			data-testid="summary-sign-in-prompt"
			class="flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-4"
		>
			<input type="hidden" name="next" value={next} />
			<span class="text-sm text-zinc-600">{m.summary_sign_in_prompt()}</span>
			<button type="submit" class={buttonClasses} data-testid="summary-sign-in">
				{m.auth_sign_in_google()}
			</button>
		</form>
	{/if}
</section>
