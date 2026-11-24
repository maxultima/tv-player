---
name: skill-integration
description: >-
  Use this skill ONLY when adding, integrating, or updating project skills from
  an external rules repository (such as my-rules). Ensures skills are copied as
  pinned snapshots and wired into AGENTS.md with context-saving, on-demand
  loading to minimize token and credit usage.
---

# Skill Integration & Update Workflow

Follow this procedure when integrating or updating skills in a target project from `<skills_source>`.

## 1. Copy Skills as Pinned Snapshots

1. Copy the desired skill folders from `<skills_source>/skills/<skill_name>/` into `<project_root>/.agents/skills/<skill_name>/`.
2. Include `skill-integration` itself so future updates in the target project follow the same rules automatically.
3. Remove `<project_root>/.agents/skills.json` if it was only pointing to `<skills_source>` — Antigravity auto-discovers `.agents/skills/` directly.

## 2. Wire `AGENTS.md` for Minimal Context Usage

To preserve session context and avoid unnecessary token/credit consumption:

- **Never** write blanket instructions such as *"always follow all skills in `.agents/skills/`"* — that forces eager loading of every `SKILL.md` on turn 1.
- Mark **`project-documentation`** as **always mandatory** on every change so `README.md` is never forgotten, while keeping all other skills **on-demand** via progressive disclosure:

```markdown
## Mandatory Always-On Skill
- `project-documentation`: ALWAYS follow on every code, config, or behavior change — update `README.md` before finishing any task.

## Project Skills (load on demand)
- `project-workflow`: load when editing project files or resolving ambiguity.
- `desktop-app-architecture`: load only when designing/implementing app architecture, IPC, i18n, logging, storage, or builds.
- `git-commit`: load only when working with git (commits, branches, tags, PRs, release notes).
- `skill-integration`: load only when adding or updating skills from an external rules repo.
```

- Keep only **project-specific rules** and tiny always-on micro-rules (e.g. *"ask in Czech on ambiguity"*) directly in `AGENTS.md`.
- Remove any rules from `AGENTS.md` that are now duplicated inside the installed skills.

## 3. Verify

1. Confirm all expected `<project_root>/.agents/skills/<name>/SKILL.md` files exist.
2. Confirm `<project_root>/AGENTS.md` contains no absolute paths and no blanket "always load all skills" instruction.
