<!--
PARTLY FOLDED. The operations parts of W0-2 (the `migrations:` rows of the log table
in §2, §6.2 Rollback, the new §6.4 Database migrations and the §6.4-§6.7 renumbering)
were folded into docs/operations.md, docs/pt-BR/operations.md and
docs/es/operations.md by W1-10. Only the .env.example migrations comment remains
below, in English and Spanish.
Owner: the task that converts .env.example to English. Delete this file once that
comment is folded in.
-->

# W0-2 docs: pending .env.example comment

This file carries only the **English (canonical)** and **Spanish** text of the migrations
comment that W0-2 added to `.env.example`. The `.env.example` file is still pt-BR only.
When it is converted, paste each part into its file and remove this one.

---

## English

### EN: .env.example, migrations comment

```
# Schema migrations: the app applies pending ones at boot. The same PG* variables
# above drive the CLI (as the table owner; see docs/operations.md §6.4), one
# command at a time:
#   node --env-file=.env.local scripts/migrate.mjs status
#   node --env-file=.env.local scripts/migrate.mjs up
#   node --env-file=.env.local scripts/migrate.mjs down --to N --yes
# `down --to 0` drops every table: test databases only.
```

---

## Español

### ES: .env.example, comentario de migraciones

```
# Migraciones del schema: el app aplica las pendientes al arrancar. Las mismas
# variables PG* de arriba sirven al CLI (como dueño de las tablas; ver
# docs/operations.md §6.4), un comando por vez:
#   node --env-file=.env.local scripts/migrate.mjs status
#   node --env-file=.env.local scripts/migrate.mjs up
#   node --env-file=.env.local scripts/migrate.mjs down --to N --yes
# `down --to 0` borra todas las tablas: solo en bases de prueba.
```
