---
name: project-documentation
description: >-
  ALWAYS use this skill on every code, configuration, or behavior change to keep
  README.md documentation accurate and up to date before finishing a task.
---

# Project Documentation (`README.md`)

Follow these rules on **every** task that modifies code, configuration, structure, or behavior.

## Rules

- **Update with every change**: With every meaningful code or behavior change, update `README.md` at `<project_root>` (or create it if it does not exist).
- **Hierarchical READMEs**: In multi-module or multi-folder projects, update both the affected subfolder's `README.md` and the root `README.md`. Preserve UTF-8 encoding and existing line endings (CRLF/LF).
- **Verifiable facts only**: Never put anything in `README.md` that cannot be verified in the codebase — no invented commands, non-existent scripts, or speculative plans.
- **Required content**: Keep `README.md` as a cohesive, up-to-date document containing both:
  1. A **User Manual** (how to install, configure, and use the project).
  2. An **Architecture Overview** (structure, key modules, and how components fit together).

## Pre-Completion Check

Before finishing a task or summarizing results to the user, verify that `README.md` reflects all changes made in this task. If not, update it first.
