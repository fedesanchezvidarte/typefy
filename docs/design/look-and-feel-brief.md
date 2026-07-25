# Typefy — Look & Feel Brief

> Output of a design grilling session. Written to be pasted into Claude Design as a starting prompt.
> Everything under **Decisions** is settled; everything under **What to design** is open and is what
> Claude Design is being asked to resolve.

## The product

Typefy is a typing web app whose core engagement is **writing and "reading" a long text at the same
time**. You type through public-domain books — Project Gutenberg in English, Cervantes Virtual and
similar in Spanish — one paragraph-sized unit at a time, seeing live per-character feedback. Finish
enough units and you have typed, and read, the whole book.

It is not a speed trainer. Monkeytype already owns the competitive-terminal look; TypeLit shares this
app's philosophy but not its polish. Typefy's wedge is **execution quality on a reading-first premise**.

Portfolio project. Free. Solo developer. SvelteKit + TypeScript, Tailwind v4 (plus Svelte scoped CSS
for the typing surface), Supabase, Vercel, Paraglide EN/ES.

## The register

A **reading sanctuary** with the discipline of a **calm, modern, professional app**.

Mood words: quiet, warm, legible, unhurried, precise, trustworthy.
Anti-mood: gamified, competitive, playful-for-its-own-sake, skeuomorphic, dashboard-y.

The single governing principle:

> **Expressiveness decreases as you approach the text.**

The library can be tactile and characterful. The passage you are typing cannot. Anything that moves,
flashes or celebrates near the reading surface is wrong.

## Decisions (settled — do not revisit)

### 1. Theming: one skeleton, two independent axes

A fixed skeleton is shared by every theme and never varies: spacing scale, radii, border weights,
layout, component anatomy, motion timings, icon set.

Two independent user-facing axes:

| Axis        | Owns                                                     | Launch set                    |
| ----------- | -------------------------------------------------------- | ----------------------------- |
| **Palette** | Colour only. Never assumes a typeface.                   | 4 — two light, two dark       |
| **Font**    | Type only. Never assumes a background.                   | 3 — sans, serif, mono         |

Default on first visit: **warm light palette + sans**.

Three conditions this model depends on, and they are non-negotiable:

1. **Strict separation.** A palette defines colour and only colour; a font defines type and only type.
2. **The three faces must be optically matched** — tuned to a shared apparent size, leading and weight,
   so switching family does not reflow the passage or change how dense the page feels.
3. **Contrast is verified per palette against the worst case** (lightest-weight serif at the smallest UI
   size). Pass there and you pass everywhere — this keeps QA at 4 checks, not 12.

Accepted trade-offs:

- No theme can carry a typographic identity. There is no "Console" theme that arrives as mono.
- No light↔dark pairing and no one-tap day/night flip. System preference only picks the initial default.
- Palettes are pure token records, so adding sepia / high-contrast / solarized / dracula later is
  appending data, not changing the model.
- Combo presets ("give me the bookish one" — sets both axes at once) are a possible later addition, not
  a launch feature.

### 2. The typing surface

**Tonal, not chromatic.** This is the boldest and most important decision in the brief.

| State       | Rendering                                                             |
| ----------- | --------------------------------------------------------------------- |
| `pending`   | Dimmed foreground                                                     |
| `correct`   | Full-strength foreground                                              |
| `corrected` | Identical to `correct` — a fixed error carries no lasting visual mark |
| `incorrect` | The **only** chromatic event on the page: error red                   |

The text visually fills in as you type. There is no green. Colour appears exactly when something needs
attention and never otherwise. This survives every palette and every form of colour blindness because
it is built on contrast, not hue.

Colour is never the sole signal: `incorrect` also carries an underline and a background tint (so a
wrong space is visible).

**Static full chunk.** The whole unit is laid out once and never moves. Nothing on screen moves but the
caret. Progress is legible from the shape of the filled text alone. This is only possible because units
are bounded at ~400–600 characters — roughly one short paragraph, six to eight lines at a comfortable
measure. It is deliberately *not* a Monkeytype-style scrolling window.

**The sheet.** The unit sits on a defined page region: its own surface colour one step off the
background, generous internal padding, minimal or no border, **no texture, no drop-shadow theatre**. It
must read correctly in the warm light palette and the near-black dark palette alike.

**Exactly two elements of chrome**, framing one sheet:

```
              Don Quixote · Cervantes

   ┌────────────────────────────────────┐
   │                                    │
   │   ████████████████████████████     │
   │   ████████▌░░░░░░░░░░░░░░░░░░░     │
   │   ░░░░░░░░░░░░░░░░░░░              │
   │                                    │
   └────────────────────────────────────┘

   Passage 12 of 350 · 26% · 68 wpm · 97%
```

Normal mode shows the full meta line. **Zen mode subtracts the metrics from that same line** — it is a
subtraction, not a different layout:

```
   Passage 12 of 350 · 26%
```

**Restrained feedback.**

- On error: the character changes state. Nothing moves. No shake, no flash, no sound.
- On completion: a brief settle (~200ms), then a soft crossfade to the next passage.
- No confetti, no score reveal, no celebration anywhere.
- Every transition needs a `prefers-reduced-motion` equivalent — instant swap, no fade. The caret
  already does this (steady instead of blinking).

### 3. The library

A grid of book cards. **Coherence comes from the frame, not the contents**: every cover occupies the
same aspect ratio inside the same card treatment, so a mixed grid still reads as one system.

Cover policy — a curated slot with a generated fallback:

- Real cover art is used **only where a human has judged it good**. Public-domain sources supply
  inconsistent, often absent or low-quality scans; there is no heuristic, the call is made per book.
- Otherwise a **generated typographic cover**, composed from the book's own title and author, set in the
  active font family on a colour drawn from the active palette. Generated covers restyle with the theme.
- `cover_url` set → art. `cover_url` null → generated.

Title and author are always shown below the card regardless of which path the cover took. Per-book
progress is shown on the card.

Library cards may use a **hover-3D tilt** — this is the one place tactile playfulness is welcome, per
the governing principle. (A plain CSS transform; no component library needed alongside Tailwind.)

### 4. Brand

**No fixed brand colour.** The wordmark and any mark render in the active palette's foreground or
accent. Theming is total rather than bolted-on.

The identity lives in **form** — the wordmark, the sheet, the tonal typing surface — not in a hue. The
warm light palette is the canonical rendering for the favicon and social card.

### 5. Landing page

**The landing page is a live typing surface.** A short real passage, already focused, responding on the
first keystroke. The concept explains itself by being done, within two seconds. An overview of how the
app works, the library, and sign-in sit below.

The app is **guest-first**: all content is world-readable, nothing is gated. Signing in (Google) buys
progress persistence and metrics history — nothing else.

### 6. Language

`chunk` is the domain term in code, schema, engine and tests. The UI says **Passage** / *pasaje*.

Explicitly **not** "page": a 100-page book may be 350 chunks, so a page count would be a false claim
about the book's real pagination. The sheet is still visually a sheet — it just does not pretend to be a
leaf of the physical book.

UI is bilingual EN/ES. Spanish strings run longer than English ones, so **no layout may be tight around
English copy**. The UI language is fully independent of the language of the book being typed.

### 7. Mobile

Responsive everywhere. Library, progress, settings and auth get real small-screen designs. The typing
surface remains usable on mobile — smaller measure, adjusted size — but is designed for a physical
keyboard and does not contort to pretend a phone is a good place to type 500 characters.

## What to design (open — this is the ask)

1. **Three typefaces** — a sans, a serif and a mono — optically matched per condition 2 above. They must
   work both as the UI face and as the typing face, at ~20px with generous leading, and must render
   Spanish diacritics (á é í ó ú ñ ü ¿ ¡) well. Prefer faces available as self-hostable web fonts.
2. **Four palettes** — two light, two dark — as complete token sets. Each must define at minimum:
   background, sheet surface, foreground, dimmed foreground (`pending`), muted (chrome/meta line),
   border, accent, error red, error tint, caret. Verify contrast per palette against the worst-case
   face. Suggested characters: a warm literary light, a cool clean light, a soft neutral dark, a punchy
   near-black.
3. **The typing screen**, shown in at least the default combination and one dark combination, mid-passage
   with a visible error.
4. **The library grid**, showing both cover paths — real art and generated — side by side to prove the
   frame holds them together.
5. **The generated cover composition** — a layout system that works for a one-word title and a
   twelve-word title, in three faces, on four palettes.
6. **The wordmark** — "typefy" — as a form that survives being recoloured by every palette.
7. **The landing page**, with the live typing surface as its hero.
8. **The settings surface** where palette and font are chosen — this is a showcase screen, since the
   theming system is a feature.
9. **The session summary** shown between passages, consistent with "no celebration".

## Non-goals

- Anything that gamifies: streaks, badges, confetti, scores, leaderboards.
- Skeuomorphism: paper texture, page edges, spines, book-spread layouts.
- A scrolling typing window.
- Green for correct characters.
- Layout, spacing or component shape varying by theme.
- A settings screen offering free mixing beyond the two declared axes.
- Any palette that assumes a typeface, or any face that assumes a background.

## Repo consequences (for implementation, after design lands)

- `src/routes/layout.css` — `--color-char-correct` moves from green-600 to foreground; the token set
  expands into a full contract covering 4 palettes and 3 font stacks.
- `README.md` — the documented "correct (green) and incorrect (red)" becomes the tonal description.
- `CONTEXT.md` — `Chunk` gains "presented to users as a **passage**"; new glossary entries for
  `Palette`, `Font family`, `Passage`.
- A new ADR for the theming model (two independent axes, palettes as data) — hard to reverse once
  message keys and tokens are written.
- Paraglide message keys named `passage_*`, EN + ES.
