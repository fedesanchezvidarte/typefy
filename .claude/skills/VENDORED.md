# Vendored skills

Some skills in this directory are copied verbatim from upstream projects rather than authored for Typefy. They are checked in (not installed via a plugin) so the workflow is self-contained and reviewable. Re-sync them from source when upstream changes.

| Skill | Source | License |
|---|---|---|
| `svelte-code-writer` | [sveltejs/ai-tools](https://github.com/sveltejs/ai-tools) → `tools/skills/svelte-code-writer` | MIT |
| `svelte-core-bestpractices` | [sveltejs/ai-tools](https://github.com/sveltejs/ai-tools) → `tools/skills/svelte-core-bestpractices` | MIT |
| `supabase` | [Supabase agent skills](https://supabase.com/docs/guides/getting-started/ai-skills) (via f1-prediction) | — |
| `supabase-postgres-best-practices` | Supabase agent skills (via f1-prediction) | — |

The Svelte skills cover **core Svelte 5 syntax** (runes, snippets, events, styling). Typefy's own `sveltekit-patterns` and `ui-ux-patterns` skills cover **project conventions** and defer to these for language-level questions — keep that split when editing.

`svelte-code-writer` shells out to `npx @sveltejs/mcp` (docs lookup + autofixer); no dependency is added to `package.json` since it runs on demand.

## Re-syncing

The Svelte skills were pulled via the GitHub API, e.g.:

```bash
gh api repos/sveltejs/ai-tools/contents/tools/skills/svelte-core-bestpractices/SKILL.md \
  --jq '.content' | base64 -d > .claude/skills/svelte-core-bestpractices/SKILL.md
```

Do not hand-edit the vendored files — changes are lost on the next sync. Put Typefy-specific guidance in the project skills instead.
