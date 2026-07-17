# Spec-Driven Development

How features get built in this repo: **no implementation without an approved spec, and no closed spec without a review against it.**

## The loop

```
Feature idea
   → Spec        (GitHub issue, label `spec` — template in .claude/skills/spec/)
   → Approval    (user approves; label ready-for-agent)
   → Design      (Architect → Feature Brief, commented on the spec issue)
   → Implement   (layer agents, phase by phase, quality gates between)
   → Verify      (full suite + review of the diff against the spec)
   → Close       (validation summary commented; issue closed)
```

The **feature-orchestrator** agent (`.claude/agents/feature-orchestrator.md`) drives the whole loop for multi-layer features. For small single-layer changes, the loop still applies but a lightweight spec (a few lines in the issue) is enough — proportionality over ceremony.

## Cast

| Piece | Location | Role |
|---|---|---|
| `feature-orchestrator` | `.claude/agents/` | Coordinates phases, enforces gates |
| `architect` | `.claude/agents/` | Feature Briefs, schema/module design, docs upkeep |
| `database-expert` | `.claude/agents/` | Migrations, RLS, Supabase MCP/CLI |
| `libs-expert` | `.claude/agents/` | Pure engine/logic in `src/lib/` (TDD) |
| `ui-ux-expert` | `.claude/agents/` | Routes, components, styling, i18n |
| `qa` | `.claude/agents/` | Vitest + Playwright, a11y audits |
| `spec` skill | `.claude/skills/spec/` | Spec template and lifecycle |
| Pattern skills | `.claude/skills/` | `architecture`, `lib-patterns`, `sveltekit-patterns`, `ui-ux-patterns`, `testing-patterns`, `supabase`, `supabase-postgres-best-practices` |

## Grounding rules

- Specs and Feature Briefs use the `CONTEXT.md` glossary and respect the ADRs (see `docs/agents/domain.md`).
- Specs live in the issue tracker (see `docs/agents/issue-tracker.md`); labels follow `docs/agents/triage-labels.md` plus the `spec` label.
- Pattern skills are **living documents**: written during bootstrapping from the ADRs, to be refined with concrete examples as real code lands. When reality diverges from a skill, fix the skill in the same PR.
