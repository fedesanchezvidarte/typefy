---
name: spec
description: "Write, publish, and manage feature specs for Typefy. Use when starting any new feature, when the user says 'write a spec', or when the feature-orchestrator runs Phase 0. Specs are GitHub issues and gate all implementation work."
---

# Spec Skill

Typefy is spec-driven: every feature starts as a **spec** — a GitHub issue that describes *what* to build and *why*, approved by the user before any implementation. The spec is the contract the final code review checks against.

## Where specs live

GitHub issues on this repo (see `docs/agents/issue-tracker.md`), labeled **`spec`**. Create the label once if missing:

```bash
gh label create spec --description "Feature specification" --color 1D76DB
```

## Lifecycle

| State | Representation | Meaning |
|---|---|---|
| **Draft** | Open issue, label `spec` + `needs-info` | Written, awaiting user review; open questions listed |
| **Approved** | Open issue, label `spec` + `ready-for-agent` | User approved; implementation may start |
| **Implemented** | Closed issue | Code merged and reviewed against the spec |
| **Rejected** | Closed issue, label `wontfix` | Decided against; keep for the record |

Approval is given by the user in chat or as an issue comment — never assume it.

## Spec template

```markdown
# Spec: [Feature Name]

## Why
[1-3 sentences: the user/product problem this solves. Reference the roadmap phase.]

## What
[Plain-language description of the behavior. Use CONTEXT.md glossary terms —
chunk, character state, corrected, session, Normal/Zen mode — never synonyms.]

## Scope
### In
- ...
### Out (explicitly)
- ...

## Affected layers
- [ ] Database (tables/columns/RLS — Supabase)
- [ ] Core logic (`src/lib/` — engine, services)
- [ ] Routes & server (`src/routes/` — load, actions, endpoints)
- [ ] UI (components, pages)
- [ ] i18n (Paraglide messages EN + ES)
- [ ] Docs (CONTEXT.md glossary, ADRs)

## Behavior & rules
[Concrete rules, edge cases, state transitions. For engine work: how does this
interact with the character state model (ADR-0004)?]

## Acceptance criteria
- [ ] [Observable, testable outcomes — each should map to at least one test]

## Open questions
- [ ] [Anything unresolved — must be empty before approval]

## Non-goals / future
[Things deliberately deferred, so nobody "helpfully" adds them.]
```

## Rules for writing a good spec

1. **Ground it in the domain docs.** Read `CONTEXT.md` and relevant ADRs first. If the spec needs a term the glossary lacks, that's a signal — propose the glossary addition in the spec.
2. **Acceptance criteria are testable.** Each criterion should translate to a Vitest or Playwright test. "Feels fast" is not a criterion; "chunk completion updates progress within the same session" is.
3. **Scope-out is explicit.** The "Out" list prevents scope creep during implementation.
4. **Open questions block approval.** A spec with open questions stays `needs-info`. Batch the questions to the user; update the spec with the answers.
5. **Small specs beat big specs.** If a spec touches more than ~3 layers with heavy changes, propose splitting it into sequential specs.
6. **ADR conflicts surface immediately.** If the spec contradicts an ADR, say so in the spec and resolve it (possibly with a superseding ADR) before approval.

## Publishing

```bash
gh issue create --title "Spec: <feature name>" --label spec --label needs-info --body-file <spec.md>
```

On approval: `gh issue edit <n> --remove-label needs-info --add-label ready-for-agent`

On completion: comment the validation summary (test results, review-against-spec outcome), then `gh issue close <n>`.
