---
name: project-workflow
description: >-
  Use this skill for general project work: enforcing strict project file access
  boundaries, English file naming, and knowing when to stop and ask the user for
  clarification (in Czech).
---

# Project Workflow: File Access & Clarification

Follow these rules during all implementation and debugging tasks.

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
