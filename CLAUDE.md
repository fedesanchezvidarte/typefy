# CLAUDE.md

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues via the `gh` CLI (`fedesanchezvidarte/typefy`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Spec-driven development

Features start as a spec (GitHub issue, label `spec`) and end with a review against it. The `feature-orchestrator` agent (`.claude/agents/`) drives the loop; project skills live in `.claude/skills/`. See `docs/agents/spec-driven.md`.
