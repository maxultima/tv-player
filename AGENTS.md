## Project Rules
- nové grafické prvky/dialogy přidané do aplikace vždy přenes i do prototypu (včetně demo dat); změny prototypu se do aplikace přenáší jen na vyžádání uživatele
- automatické přehrání (start, probuzení, připomínka, hlídací pes) je vždy tiché: nikdy toast ani zahození stavu, aby to selhalo s možností retry; hlasité (toast + úklid) jen po přímé akci uživatele (klik, klávesa, dokončený login)

## Mandatory Always-On Skill
- `project-documentation`: ALWAYS follow on every code, config, or behavior change — update `README.md` before finishing any task.

## Project Skills (load on demand)
- `project-workflow`: load when editing project files or resolving ambiguity.
- `desktop-app-architecture`: load only when designing/implementing app architecture, IPC, i18n, logging, storage, or builds.
- `git-commit`: load only when working with git (commits, branches, tags, PRs, release notes).
- `skill-integration`: load only when adding or updating skills from an external rules repo.
