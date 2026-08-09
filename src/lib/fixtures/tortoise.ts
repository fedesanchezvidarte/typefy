/**
 * Deliberately short EN fixture (spec #17 §9): a three-chunk book.
 *
 * Its whole purpose is to be *smaller than one window*. Phase 3b (#18) replaces the
 * load-everything read path with a 10-chunk window, and three cases need a book this size to
 * be cheap to test: a book shorter than a window, resuming past the end of one, and completing
 * an entire book in under a minute. The other fixtures are 5 and 6 chunks; a real novel is
 * thousands. Nothing in between exercises those edges.
 *
 * The text is an original retelling of "The Tortoise and the Hare", an Aesopic folk tale in the
 * public domain. Written for this fixture rather than taken from a particular translation, so
 * its provenance needs no verification — the point is real prose with real sentence rhythm,
 * not a specific edition.
 *
 * The title sorts after "Pride and Prejudice (excerpt)", which keeps `getHeroBook`'s
 * alphabetical pick unchanged. 3b makes the hero explicit and removes that constraint.
 *
 * Hand-chunked per ADR-0005 (443/412/448 chars, never cutting a sentence) and written in the
 * typeable character set from the start (`src/lib/ingest/characters.ts`).
 */
import type { TypeableText } from '$lib/types';

export const tortoiseAndHare: TypeableText = {
	id: 'tortoise-and-hare',
	// Like the other Phase 1-era fixtures, this predates its database row: a deliberately fake,
	// stable placeholder that is NOT a uuid and must never be used to address a row (spec #12).
	bookId: 'fixture-book-tortoise-and-hare',
	title: 'The Tortoise and the Hare',
	author: 'Aesop',
	language: 'en',
	chunkCount: 3,
	coverUrl: null,
	chunks: [
		{
			id: 'tortoise-and-hare-0',
			textId: 'tortoise-and-hare',
			index: 0,
			content:
				'A hare once mocked a tortoise for the slowness of his feet. The tortoise, who was not easily moved to anger, replied that he would gladly run a race, and that he would reach the mark before the hare did. The hare thought the boast so absurd that he agreed to the contest at once, and a fox was chosen to set the course and to judge the finish. The animals of the wood gathered along the road to watch, for they had never seen a stranger match.',
			charCount: 443
		},
		{
			id: 'tortoise-and-hare-1',
			textId: 'tortoise-and-hare',
			index: 1,
			content:
				'When the signal was given the hare shot forward and was soon so far ahead that the tortoise could no longer be seen behind him. Certain that the race was already won, he lay down in the shade beside the path and told himself that he would sleep a little and still have time enough. The tortoise meanwhile went on without stopping, one slow step after another, and never once turned his head to look for the hare.',
			charCount: 412
		},
		{
			id: 'tortoise-and-hare-2',
			textId: 'tortoise-and-hare',
			index: 2,
			content:
				'The afternoon grew warm and the hare slept far longer than he had meant to. When at last he woke and remembered the race, he ran as he had never run before, and the wind of his going bent the grass on either side of the road.\nBut the road ahead of him was empty. He came over the last rise and saw the tortoise standing quietly at the mark, with the fox beside him and the animals of the wood cheering.\nSlow and steady, said the fox, wins the race.',
			charCount: 448
		}
	]
};
