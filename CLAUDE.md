# PickChick

Следовать общим правилам в `AGENTS.md` в корне репозитория.
План разработки: `README.md` и `docs/01-technical-spec.md` — `docs/07-sources.md`.
Состояние этапов: `docs/project-status.md`.

Эти документы общие для инструментов Anthropic и OpenAI. Не создавать
отдельную противоречащую копию архитектуры или бизнес-правил.
Завершённые изменения коммитить, проверять и отправлять в канонический
GitHub-репозиторий согласно `AGENTS.md`.

Общий процесс ECC для Claude и Codex: `docs/collaboration/ecc.md` и
`.agents/skills/pickchick-control/SKILL.md` (`/pickchick-control` в Claude).
Проверять полный diff, сохранять результаты проверок и передавать контекст
через проверенный коммит/PR. Локальная память ECC не подменяет эти документы.
