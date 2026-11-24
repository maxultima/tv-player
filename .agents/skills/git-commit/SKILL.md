---
name: git-commit
description: >-
  Use this skill whenever creating git commits, branches, tags, pull requests,
  or release notes. Enforces English-only git metadata, Conventional Commits
  formatting, clean staging hygiene, and structured release notes.
---

# Git Commit & Release Workflow

Follow these rules whenever committing changes, naming branches/tags, opening PRs, or writing release notes.

## Commit Policy

- **No automatic commits**: Never commit automatically. Create a commit only when the user explicitly asks for it.

## Language

- Write **all** git metadata strictly in **English**: commit messages, branch names, tag names, pull request titles/descriptions, and release notes.

## Commit Message Format

### Standard Commits
Use [Conventional Commits](https://www.conventionalcommits.org/) with a concise, imperative subject line:

```text
<type>: <concise summary>

- Optional bullet point for multi-part changes
- Keep each bullet focused on what changed and why
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`.

### Release Commits
For versioned releases, use:

```text
Release vX.Y.Z: <short comma-separated summary of highlights>
```

Example:
```text
Release v0.5.1: independent wake recovery, auto-trimmed transparent logos, UI & timeshift fixes
```

## Release Notes Format

When writing release notes (GitHub releases, annotated tags, or changelogs), always group items under these categories with icons and use concise, single-line bullet points:

```markdown
### ✨ New Features
- ...

### 🐛 Fixes & Improvements
- ...

### 📦 Package
- ...
```

## Pre-Commit Checklist

1. Run the project's available local checks (e.g. typecheck, unit tests, linter) and verify they pass.
2. Run `git status` and verify no redundant, duplicate, or temporary files (e.g. stray binaries, scratch diagnostics) are untracked or staged.
3. Stage only the intended files and inspect `git diff --staged`.
4. Verify the commit message is in English and follows the format above.
5. Commit and confirm a clean working tree with `git status`.

## Post-Commit

- After completing a larger commit or release in a long conversation, briefly remind the user that they can run `/compact` to free up context for the next task.
