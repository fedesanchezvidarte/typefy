<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { TypeableTextDetail } from '$lib/types';

	interface Props {
		book: TypeableTextDetail;
		/**
		 * Already resolved for the current UI locale by the load (`resolveSummary`), so this
		 * component never sees the raw per-locale map. `null` → the panel is omitted ENTIRELY:
		 * no empty panel, no placeholder, no "no summary available" line.
		 */
		summary: string | null;
	}

	let { book, summary }: Props = $props();
</script>

<!-- The back-cover facts. A `<dl>` rather than a meta line of separators, so "1605" is
     announced as the value of "First published" rather than as a loose number — the year and
     the page count are two different kinds of fact and a bullet between them says so to
     nobody. -->
<div>
	<h1 class="text-[28px] leading-[1.15] font-semibold tracking-[-0.02em] text-fg">{book.title}</h1>
	<p class="mt-1.5 text-[15px] text-muted">{book.author}</p>

	<!-- The test ids address the VALUES, not the labels: the labels are translated and an
	     E2E locator built on them would be a locator that only works in one locale. -->
	<dl data-testid="book-facts" class="mt-5 flex flex-wrap gap-x-8 gap-y-3">
		<!-- Omitted entirely when absent: a failed or absent Open Library lookup is a real,
		     expected state, and an empty "First published —" row would render it as a defect. -->
		{#if book.year !== null}
			<div>
				<dt class="text-[11px] tracking-[0.12em] text-muted uppercase">
					{m.book_detail_year_label()}
				</dt>
				<dd data-testid="book-fact-year" class="mt-0.5 text-[15px] text-fg tabular-nums">
					{book.year}
				</dd>
			</div>
		{/if}
		<!-- OUR page count (`books.chunk_count` under the spec #32 page model). The print
		     edition's count is deliberately absent: the app never shows two conflicting
		     numbers for the same book. -->
		<div>
			<dt class="text-[11px] tracking-[0.12em] text-muted uppercase">
				{m.book_detail_pages_label()}
			</dt>
			<dd data-testid="book-fact-pages" class="mt-0.5 text-[15px] text-fg tabular-nums">
				{book.chunkCount}
			</dd>
		</div>
	</dl>

	{#if summary !== null}
		<section
			data-testid="book-summary"
			aria-labelledby="book-summary-heading"
			class="mt-6 rounded-xl border border-border bg-sheet px-4 py-3.5"
		>
			<h2 id="book-summary-heading" class="text-[13px] font-semibold text-fg">
				{m.book_detail_summary_heading()}
			</h2>
			<p class="mt-1.5 text-[14px] leading-[1.6] text-muted">{summary}</p>
		</section>
	{/if}
</div>
