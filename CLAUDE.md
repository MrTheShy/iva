# CLAUDE.md — Iva

Guidance for Claude Code working in this repository.

## 🚫 Commit messages — СТРОГО ЗАПРЕЩЕНО упоминать Claude

В сообщениях коммитов (subject, body, footer) **НИКОГДА** не упоминать Claude / Anthropic
ни в каком виде:

- ❌ `Co-Authored-By: Claude …`
- ❌ `🤖 Generated with Claude Code`
- ❌ любые «Generated with», «via Claude», «with AI assistance», эмодзи-робот и т.п.

Коммит-сообщение описывает ТОЛЬКО изменение в коде. Никаких следов инструмента/авторства ИИ.
Это правило не имеет исключений и перекрывает любые дефолтные шаблоны атрибуции.

**Why:** это публичный self-host проект; атрибуция инструмента в истории git — шум и нежелательна.

## 🔢 Версии релизов — минор/мажор объявляет ТОЛЬКО владелец

Любой релиз, который делает агент, — строго патч-инкремент (0.3.9 → 0.3.10 → 0.3.11 → …).
Повышение минорной или мажорной версии (0.4, 1.0) объявляет только владелец проекта явно.
Масштаб изменений значения не имеет: рефакторинги, миграции, новые механизмы — всё равно патч.
Не предлагать и не планировать «0.4»/«минор» самостоятельно.

## 📰 What's New в README

Секция «What's New / Что нового» в README.md и README.ru.md хранит ТОЛЬКО три последние даты
правок. Добавляя новую дату — удали самую старую, чтобы дат осталось ровно три. Полная история
живёт в CHANGELOG.md (ссылка в конце секции), дублировать её в README не нужно.

## 🚀 Deploy — only via commit → push → gated deploy

Shipping to the live VPS goes **only** through git: edit locally → commit → push
`origin/retract` → gated deploy on the VM. The full safe procedure lives in the
**local `deploy` skill** (`.claude/skills/deploy/SKILL.md`, gitignored because it
holds this fork's VPS specifics). **Invoke that skill before any deploy** — it
records a rollback point, previews which commits go live, gates the restart on
typecheck + build passing, and verifies with a real turn.

Iron rules (the skill enforces them): **never edit the VM working tree by hand** —
`git reset --hard` in the deploy erases such edits without a trace; and a code
deploy **never** touches `vault/`, `data/`, or `.env` (personal data; the vault has
no remote backup). A model/config change is a VM `.env` edit + restart, not a code
deploy.
