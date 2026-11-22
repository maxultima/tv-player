---
name: project-workflow
description: >-
  Use this skill for general project work: enforcing strict project file access
  boundaries, knowing when to stop and ask the user for clarification (in Czech),
  and keeping README documentation up to date with every change.
---

# Project Workflow: File Access, Clarification & Documentation

Follow these rules during all implementation, debugging, and documentation tasks.

## 1. Project File Access & Cleanliness

- **Stay inside the project root**: Never read, modify, or create files outside the project root directory.
- **Explicit external paths**: Access an external directory only when the user explicitly provides it in the current prompt. Keep `<external_dir>` in conversation context only — never persist it into project files or rules.
- **No absolute paths in rules**: Never write absolute paths in rules, skills, or documentation. Always use placeholders such as `<external_dir>` or `<project_root>`.
- **Temp directory**: You may use the system temp directory outside the project for scratch work and diagnostics.
- **No redundant or temporary files in the project**: Never leave duplicate files, binary copies, or temporary diagnostic files inside the project root. Place diagnostics in the temp directory or delete them immediately after use.
- **English file and directory names**: Always name files, folders, and feature slugs in English (`docs/`, `design/`, `src/`, scripts, etc.), even when documentation content or UI text is in Czech.

## 2. When to Stop and Ask

- **Stop on ambiguity**: Whenever a requirement, specification, or architectural decision is unclear or ambiguous, stop implementation and ask the user. Never guess or silently fill in missing decisions.
- **Ask in Czech**: Always formulate questions to the user in Czech.
- **Bug/issue lists refer to the latest build**: When the user provides a list of issues, assume it always refers to the latest build — do not question or double-check which build they tested.
- **Summarize before the final build**: Before running the final build, present the summary/conclusion first (the overview you would normally write at the end).

## 3. Documentation (`README.md`)

- **Update with every change**: With every meaningful code or behavior change, update `README.md` at `<project_root>` (or create it if it does not exist).
- **Hierarchical READMEs**: In multi-module/multi-folder projects, update both the affected subfolder's `README.md` and the root `README.md`. Preserve UTF-8 encoding and existing line endings (CRLF/LF).
- **Verifiable facts only**: Never put anything in `README.md` that cannot be verified in the codebase — no invented commands, non-existent scripts, or speculative plans.
- **Required content**: Keep `README.md` as a cohesive, up-to-date document containing both:
  1. A **User Manual** (how to install, configure, and use the project).
  2. An **Architecture Overview** (structure, key modules, and how components fit together).
