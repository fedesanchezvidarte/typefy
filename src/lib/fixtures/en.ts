/**
 * Hardcoded EN fixture for Phase 1 (spec #5): an excerpt of the opening of
 * "Pride and Prejudice" by Jane Austen (1813), public domain.
 * Source: Project Gutenberg eBook #1342 (https://www.gutenberg.org/ebooks/1342).
 *
 * Hand-chunked per ADR-0005 (~400-600 chars, never cutting a sentence) and
 * hand-normalized to straight ASCII punctuation: curly quotes straightened,
 * emphasis underscores removed, double hyphens normalized to " - ", paragraph
 * breaks inside a chunk collapsed to single spaces. Chunk 0 (377 chars) sits
 * below target: grouping the following dialogue line in would leave the next
 * chunk badly undersized (justified boundary exception, see spec #5).
 */
import type { TypeableText } from '$lib/types';

export const prideAndPrejudiceExcerpt: TypeableText = {
	id: 'pride-and-prejudice-excerpt',
	title: 'Pride and Prejudice (excerpt)',
	author: 'Jane Austen',
	language: 'en',
	chunkCount: 6,
	coverUrl: null,
	chunks: [
		{
			id: 'pride-and-prejudice-excerpt-0',
			textId: 'pride-and-prejudice-excerpt',
			index: 0,
			content:
				'It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife. However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered as the rightful property of some one or other of their daughters.',
			charCount: 377
		},
		{
			id: 'pride-and-prejudice-excerpt-1',
			textId: 'pride-and-prejudice-excerpt',
			index: 1,
			content:
				'"My dear Mr. Bennet," said his lady to him one day, "have you heard that Netherfield Park is let at last?" Mr. Bennet replied that he had not. "But it is," returned she; "for Mrs. Long has just been here, and she told me all about it." Mr. Bennet made no answer. "Do not you want to know who has taken it?" cried his wife, impatiently. "You want to tell me, and I have no objection to hearing it." This was invitation enough.',
			charCount: 425
		},
		{
			id: 'pride-and-prejudice-excerpt-2',
			textId: 'pride-and-prejudice-excerpt',
			index: 2,
			content:
				'"Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week." "What is his name?" "Bingley."',
			charCount: 428
		},
		{
			id: 'pride-and-prejudice-excerpt-3',
			textId: 'pride-and-prejudice-excerpt',
			index: 3,
			content:
				'"Is he married or single?" "Oh, single, my dear, to be sure! A single man of large fortune; four or five thousand a year. What a fine thing for our girls!" "How so? how can it affect them?" "My dear Mr. Bennet," replied his wife, "how can you be so tiresome? You must know that I am thinking of his marrying one of them." "Is that his design in settling here?" "Design? Nonsense, how can you talk so! But it is very likely that he may fall in love with one of them, and therefore you must visit him as soon as he comes."',
			charCount: 520
		},
		{
			id: 'pride-and-prejudice-excerpt-4',
			textId: 'pride-and-prejudice-excerpt',
			index: 4,
			content:
				'"I see no occasion for that. You and the girls may go - or you may send them by themselves, which perhaps will be still better; for as you are as handsome as any of them, Mr. Bingley might like you the best of the party." "My dear, you flatter me. I certainly have had my share of beauty, but I do not pretend to be anything extraordinary now. When a woman has five grown-up daughters, she ought to give over thinking of her own beauty." "In such cases, a woman has not often much beauty to think of."',
			charCount: 501
		},
		{
			id: 'pride-and-prejudice-excerpt-5',
			textId: 'pride-and-prejudice-excerpt',
			index: 5,
			content:
				'"But, my dear, you must indeed go and see Mr. Bingley when he comes into the neighbourhood." "It is more than I engage for, I assure you." "But consider your daughters. Only think what an establishment it would be for one of them. Sir William and Lady Lucas are determined to go, merely on that account; for in general, you know, they visit no new comers. Indeed you must go, for it will be impossible for us to visit him, if you do not."',
			charCount: 438
		}
	]
};
