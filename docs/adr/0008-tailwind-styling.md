# ADR-0008 — Tailwind CSS for styling

**Status:** Accepted

## Context

We need to choose the styling approach for a portfolio app with an interactive UI. The owner already used
Tailwind in another project.

## Decision

Use **Tailwind CSS** as the main approach, with **Svelte's native scoped CSS** for specific cases (the
typing engine with per-character state and dynamic colors, and animations).

## Consequences

- Iteration speed and recognizable portfolio signal.
- Does not scatter the focus: Tailwind is utility-based, not a new paradigm; already known.
- Coexists without friction with the scoped CSS Svelte provides out of the box.

## Alternatives considered

- **Svelte native scoped CSS (only)** — Very clean for a small app, but lower portfolio signal.
- **UnoCSS** — Similar to Tailwind but another new piece, against the principle of not spreading thin.
