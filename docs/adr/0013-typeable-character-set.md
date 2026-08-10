# ADR-0013 — Typeable character set and source normalization

**Status:** Accepted

## Context

Phase 3 ingests real public-domain texts instead of hand-chunked fixtures. Raw sources carry
typography no keyboard produces: curly quotes, em dashes, ellipsis characters, non-breaking
spaces, and — in real English prose — French loanwords like *théâtre*, *tête-à-tête* and
*manœuvre*, all three of which appear in Pride and Prejudice.

This collides with the engine. [ADR-0004](0004-typing-engine-model.md) judges each character by
exact comparison, and a chunk completes only when no character is `pending` or `incorrect`. So a
single unreachable glyph does not merely annoy: it makes that passage **impossible to complete**,
and because progress advances passage by passage, it silently walls off the rest of the book.

Something has to give — the stored text, or the engine's exactness.

Phase 1's fixtures had already answered this without writing it down. Hand-chunking quietly
normalised typography away: the fixtures contain ASCII plus `á é í ó ú ü ñ ¿ ¡` and nothing else,
no curly quotes and no em dashes. The rule existed as a habit, enforced by nobody.

## Decision

**Ingestion folds source text into a typeable character set. The engine's comparison stays
exact and gains no equivalence rules.**

The set is what an English or Spanish keyboard actually produces:

- printable ASCII (U+0020–U+007E) and the newline;
- `á é í ó ú ü ñ Á É Í Ó Ú Ü Ñ ¿ ¡`.

Everything else is folded at ingestion:

| From | To | Why |
|---|---|---|
| `“ ” „ ‟ « »` | `"` | Both guillemets included — Spanish sources use them |
| `‘ ’ ‚ ‛` | `'` | |
| `— – ‒ ―` | `-` | The hyphen is the only dash on a keyboard |
| `…` | `...` | Expanded, not dropped — three periods is what a typist writes |
| No-break, thin, figure, ideographic spaces | ` ` | |
| BOM, zero-width space/joiner/non-joiner, soft hyphen | *(removed)* | Removed rather than spaced: a soft hyphen sits **inside** a word |
| U+2028, U+2029 | `\n` | They are line breaks, not spaces |
| Any other Latin letter with a diacritic | its base letter | `ê` → `e`, `à` → `a` |
| `œ Œ æ Æ ß` | `oe OE ae AE ss` | Ligatures are one code point; decomposition cannot expand them |

Unicode **NFC** runs first, before anything inspects a character, so a decomposed accent is a
single code point rather than a base letter plus a combining mark.

Two rules govern the general fold:

1. **A character already in the set survives wherever it appears.** `théâtre` becomes `théatre`,
   not `theatre`. The rule is about the keyboard, not about a word's language of origin —
   ingestion has no way to know the latter and no reason to care.
2. **A character that cannot be folded is never silently deleted.** It is reported, with its code
   point, count and surrounding context, and ingestion refuses to write the book. Quiet deletion
   is how text gets corrupted without anyone noticing.

The allowed set is asserted against the Phase 1 fixtures in the test suite, so it stays a
*description* of what hand-cleaning already produced rather than a constraint invented later.

### Scope: this governs text the user must TYPE, not text the app displays

Stated explicitly as of Phase 5d (spec #34), because until then it was only implicit and the
distinction is about to look like an oversight.

**The rule applies to typeable text — a book's chunks — and to nothing else.** Its entire
justification is the engine's exact comparison: a character outside the set makes a passage
*impossible to complete* and silently walls off the rest of the book. That argument has no purchase
on text nobody types. Interface copy, book titles and authors, and — the case that prompted this —
**book summaries** are display-only, and typography in them is not a defect.

So `books.summary` legitimately contains curly quotes, em dashes and ellipsis characters, straight
from Open Library, and `findDisallowed` is **deliberately not run over it**
([ADR-0019](0019-ingest-time-open-library-metadata.md)). `scripts/ingest.ts` calls `findDisallowed`
on the cleaned source text only; `src/lib/ingest/open-library.ts` carries the same note at the top
of the module.

**This is not a weakening of the rule, and gating the summary on it would not be extra safety — it
would be a category error.** A blurb full of hyphens where the source had em dashes buys nothing (no
one types it) and costs fidelity in the one place fidelity is free. A future reader who notices that
a summary contains `—` and reaches for the normalizer should stop here: the absence is the decision.

The boundary is stated as a question rather than a list, so it holds for content this project has
not built yet: *does the user have to reproduce this character on a keyboard?* If yes, the set
applies. If no, it does not.

## Consequences

- The typing engine — the most-tested module in the codebase — needs no change, no equivalence
  classes, and no notion of "close enough". `correct` stays unambiguous, which keeps the
  first-attempt record and Accuracy (raw) unambiguous with it.
- Stored text is **not byte-faithful** to its source. `books.source_url` is the fidelity story:
  the original is one click away, and the manifest records the licence it came under.
- A reader loses some typographic texture: em dashes become hyphens, curly quotes straighten.
  Acceptable — the product is a *typing* app, and the alternative is text that cannot be typed.
- The fold is not free of judgement. `manœuvre` → `manoeuvre` is a spelling change, not just a
  glyph change. Recorded here deliberately, since it is the kind of thing that looks like a bug
  to someone who did not read this.
- The rule generalises to any future content language whose letters happen to be Latin. A
  language that needs a genuinely different alphabet would need this ADR revisited, not extended.

## Alternatives considered

- **Teach the engine equivalence classes** — store the source's real typography and accept `"`
  for `“`, `-` for `—`. Faithful display and forgiving input, but it changes the core comparison
  in ADR-0004, makes "correct" fuzzy, and raises a question with no good answer: is typing the
  real `—` also correct? It would put the most delicate change in the most-tested module for a
  problem that belongs to ingestion.
- **Normalize encoding only (NFC and exotic whitespace), keep punctuation** — a minimal,
  defensible transform. Rejected because it leaves untypeable glyphs in the text, and one of them
  is enough to make a passage impossible to finish. The failure is invisible until a user hits it.
- **Extend the allowed set to cover French, Portuguese and German diacritics** — more faithful,
  and defensible for a reader. Rejected because it optimises for the wrong half of the product:
  the user has to *type* these, and `ê` is not on an English or Spanish keyboard.
- **Reject any source containing an unfoldable character** — simple and safe, but it would
  disqualify most real prose over a handful of loanwords.
