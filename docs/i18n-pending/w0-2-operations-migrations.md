<!--
PENDING TRANSLATIONS: fold into the final docs layout, then delete this file.
Owner: whoever converts docs/operations.md to the EN-canonical layout (docs i18n
tasks W1-10 / W2-10). Source of truth today: the pt-BR text added by W0-2 in
docs/operations.md (§2 log rows for `migrations:`, §6.2 Rollback, §6.4 Migrações
do banco, the §6.4–§6.7 renumbering) and the migrations comment in .env.example.
-->

# W0-2 docs: English and Spanish versions (pending fold-in)

This file carries the **English (canonical)** and **Spanish** text of the sections W0-2
added in Portuguese to `docs/operations.md` and `.env.example`. `docs/operations.md` is
still pt-BR only. When the trilingual layout lands, paste each part into its file and
remove this one. Section numbers: the old §6.4 "Tokens e Lakebase" is now §6.5, §6.5 is
§6.6 and §6.6 is §6.7.

---

## English

### EN: docs/operations.md, §2 log messages (new rows)

| Message (start) | Meaning | Action |
|---|---|---|
| `migrations: applied <NNNN> <name>` / `migrations: recorded 0001 baseline for an existing 1.x schema (no DDL run)` | A migration was applied at boot / a 1.x database was recorded as version 1 | Expected once per new migration. See §6.4 |
| `migrations: existing 1.x schema is incomplete (missing N: …)` | A 1.x database lacks some baseline item (table, column, index or constraint); the idempotent `0001` runs instead of only being recorded | None, unless the next line follows |
| `migrations: after 0001 baseline the schema still differs from the baseline (…)` | Drift `0001` cannot repair (e.g. a constraint dropped by hand); the app keeps running | Fix by hand or restore a backup (§6.4) |
| `migrations: the database has versions this code does not know (…)` | The database was migrated by a newer release (e.g. after a code rollback) | Expected during a rollback; see §6.2 |
| `migrations: no privilege to record the schema version (42501: …)` | The app's identity cannot create or write `schema_migrations`; the 1.x schema is complete and the app keeps running | Run `scripts/migrate.mjs up` as the table owner (§6.4) |
| `migrations: applied file changed: …` `[MIGRATION_CHECKSUM]` | A migration file that was already applied has been edited; the app does not start | Restore the released file (§6.4) |

### EN: docs/operations.md, §6.2 Rollback

The normal rollback is a **code** rollback. The database schema only goes back with it
when the new version brought a migration the old one cannot live with (see §6.4).

1. Find the last good commit (tag or SHA) whose `client/dist` and `server-dist` were
   consistent.
2. **Schema:** compare `server/migrations/` in both versions. If the new version brought
   no migration, or its new migration only adds (a table or column the old version
   ignores), leave the database alone: the old version boots fine on a newer database
   (every boot logs `the database has versions this code does not know`). If the new
   migration changes something the old version reads, run the `down` **with the new code
   still at hand**, before switching code:
   `node scripts/migrate.mjs down --to <last version of the old release> --yes`.
3. Check out the good artifacts on a hotfix branch (do not rewrite `main`).
4. Repeat §6.1 from step 1.
5. Confirm with `npm run smoke`.

*Warning:* a migration's `down` can delete data that only the new version wrote. Read the
`.down.sql` file before running it.

### EN: docs/operations.md, §6.4 Database migrations

The Lakebase schema is versioned in SQL files:

```
server/migrations/NNNN_<name>.up.sql     the change (required)
server/migrations/NNNN_<name>.down.sql   its rollback (required)
```

The `schema_migrations(version, name, checksum, applied_at)` table records what has been
applied. Version `0001_baseline` is exactly the schema 1.4 created at boot.

**At boot (automatic).** The first request of each process runs `ensureSchema`, which
applies the pending migrations in order. Each one runs in a transaction together with its
`schema_migrations` row: it is either fully applied and recorded, or not applied. A
Postgres advisory lock lets only one process migrate at a time; the others wait and then
find everything applied. With everything applied, the cost is two `SELECT`s and no lock. The wait for the lock is
bounded (2 min): after that the request fails with `[MIGRATION_LOCK_TIMEOUT]` and the next
one retries. Because each file runs in a transaction, statements Postgres refuses inside a
transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`) cannot go in a migration.

**Database created by a 1.x version.** Without `schema_migrations`, the runner checks in the
Postgres catalog every table, column, index and constraint (with its definition) that
`0001` creates. If all of it is there, it records version 1 without running any DDL (log
`recorded 0001 baseline for an existing 1.x schema`). If anything is missing (an older 1.x,
or a partial schema), it runs the whole `0001`, which is idempotent and fills in what is
missing without touching the data, and logs what was missing
(`existing 1.x schema is incomplete`). `0001` does not recreate everything: a constraint
dropped by hand, for example, stays missing. The log then says
`the schema still differs from the baseline` with the list, and the app keeps running;
fix it by hand.

**Identity.** Whoever creates `schema_migrations` and runs DDL must own the tables. If the
app boots as the service principal on a database another identity created, and the 1.x
schema is already complete, the app keeps working and logs
`migrations: no privilege to record the schema version`. In that case run `up` once as
the owner (below). If a new migration is pending and the SP cannot apply it, the error
surfaces. A `permission denied` makes the app retry with the user's identity, as in the
GRANTs flow of §6.5. A `must be owner` (ALTER by a non-owner) fails the request: run `up` as
the owner before releasing the version.

**From the command line.** `scripts/migrate.mjs` uses the standard Postgres variables
(`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`) and the app's
`PG_SSL_CA`/`PG_SSL_REJECT_UNAUTHORIZED`. On Lakebase, use a database credential of the
table owner as `PGPASSWORD` (`databricks database generate-database-credential`). The CLI
token is not accepted. Every command first prints its target
(`target: <host>:<port>/<database> as <user>`): check it before going on, above all when
`.env.local` points at the same Lakebase as the app.

```bash
# what is applied, pending or changed (exits 1 if an applied file changed)
node scripts/migrate.mjs status

# upgrade: apply the pending ones (what the boot does)
node scripts/migrate.mjs up

# rollback: undo, newest first, every version above N
# (without --yes it only prints the target and stops)
node scripts/migrate.mjs down --to <N> --yes

# local development database
node --env-file=.env.local scripts/migrate.mjs status
```

`down --to 0` undoes `0001_baseline`, that is, it **drops every app table and its data**,
and then drops `schema_migrations` itself: the schema is left empty. Use it only on a test
or CI database. In production a schema rollback is one specific,
planned migration (§6.2).

**File changed after it was applied.** The runner stores the SHA-256 of each applied
`.up.sql` (CRLF line endings and a BOM do not count). If the file changed, the boot and
`up` stop with `migrations: applied file changed … [MIGRATION_CHECKSUM]` and nothing else
runs: two databases with the same version and different schemas would be worse than a
stopped app. Restore the file from the release and put the change in a new migration.

**Schema changes (developers).** Never edit a released file and never put DDL in
`server/db.js`. Create the next number (`0002_<name>.up.sql` and `.down.sql`) with a tested
`down`: `server/migrate.test.js` shows the round-trip test on a scratch database. Queries
for a new feature go in `server/db/<feature>.js`, using `withClient` or `withTx`
(transaction) from `server/db/pool.js`.

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

### ES: docs/operations.md, §2 mensajes de log (filas nuevas)

| Mensaje (inicio) | Significado | Acción |
|---|---|---|
| `migrations: applied <NNNN> <nombre>` / `migrations: recorded 0001 baseline for an existing 1.x schema (no DDL run)` | Se aplicó una migración en el arranque / una base 1.x quedó registrada como versión 1 | Esperado una vez por migración nueva. Ver §6.4 |
| `migrations: existing 1.x schema is incomplete (missing N: …)` | A una base 1.x le falta algún elemento del baseline (tabla, columna, índice o constraint); se ejecuta el `0001` idempotente en lugar de solo registrarlo | Ninguna, salvo que aparezca la línea siguiente |
| `migrations: after 0001 baseline the schema still differs from the baseline (…)` | Divergencia que el `0001` no corrige (p. ej. una constraint borrada a mano); el app sigue | Corregir a mano o restaurar un backup (§6.4) |
| `migrations: the database has versions this code does not know (…)` | Una release más nueva migró la base (p. ej. después de un rollback de código) | Esperado en un rollback; ver §6.2 |
| `migrations: no privilege to record the schema version (42501: …)` | La identidad del app no puede crear ni escribir `schema_migrations`; el schema 1.x está completo y el app sigue | Ejecutar `scripts/migrate.mjs up` como dueño de las tablas (§6.4) |
| `migrations: applied file changed: …` `[MIGRATION_CHECKSUM]` | Se editó un archivo de migración ya aplicado; el app no arranca | Restaurar el archivo publicado (§6.4) |

### ES: docs/operations.md, §6.2 Rollback

El rollback normal es de **código**. El schema de la base solo vuelve atrás junto con él
cuando la versión nueva trajo una migración que la anterior no soporta (ver §6.4).

1. Identifique el último commit bueno (tag o SHA) con `client/dist` y `server-dist`
   consistentes.
2. **Schema:** compare `server/migrations/` de las dos versiones. Si la versión nueva no
   trajo migración, o si la migración nueva solo agrega (una tabla o columna que la versión
   anterior ignora), no toque la base: la versión anterior arranca sin problema sobre una
   base más nueva (cada arranque registra `the database has versions this code does not know`). Si la
   migración nueva cambia algo que la anterior lee, ejecute el `down` **con el código nuevo
   todavía a mano**, antes de cambiar el código:
   `node scripts/migrate.mjs down --to <última versión de la release anterior> --yes`.
3. Haga checkout de los artefactos buenos en una rama de hotfix (no reescriba `main`).
4. Repita §6.1 desde el paso 1.
5. Confirme con `npm run smoke`.

*Atención:* el `down` de una migración puede borrar datos que solo la versión nueva grabó.
Lea el archivo `.down.sql` antes de ejecutarlo.

### ES: docs/operations.md, §6.4 Migraciones de la base

El schema del Lakebase se versiona en archivos SQL:

```
server/migrations/NNNN_<nombre>.up.sql     el cambio (obligatorio)
server/migrations/NNNN_<nombre>.down.sql   su rollback (obligatorio)
```

La tabla `schema_migrations(version, name, checksum, applied_at)` registra lo que ya se
aplicó. La versión `0001_baseline` es exactamente el schema que la 1.4 creaba al arrancar.

**Al arrancar (automático).** La primera petición de cada proceso ejecuta `ensureSchema`,
que aplica las migraciones pendientes en orden. Cada una corre en una transacción junto con
su fila en `schema_migrations`: o entra completa y registrada, o no entra. Un advisory lock
de Postgres deja migrar a un solo proceso a la vez; los demás esperan y encuentran todo
aplicado. Con todo aplicado, el costo son dos `SELECT` y ningún lock. La espera del lock tiene límite
(2 min): pasado ese tiempo, la petición falla con `[MIGRATION_LOCK_TIMEOUT]` y la siguiente
vuelve a intentar. Como cada archivo corre en una transacción, los comandos que Postgres
rechaza dentro de una transacción (`CREATE INDEX CONCURRENTLY`, `VACUUM`) no pueden ir en
una migración.

**Base creada por una versión 1.x.** Sin `schema_migrations`, el runner revisa en el catálogo
de Postgres cada tabla, columna, índice y constraint (con su definición) que crea el `0001`.
Si está todo, registra la versión 1 sin ejecutar DDL (log
`recorded 0001 baseline for an existing 1.x schema`). Si falta algo (una 1.x más antigua o
un schema parcial), ejecuta el `0001` completo, que es idempotente y completa lo que falta
sin tocar los datos, y registra lo que faltaba (`existing 1.x schema is incomplete`). El
`0001` no recrea todo: una constraint borrada a mano, por ejemplo, sigue faltando. En ese
caso el log dice `the schema still differs from the baseline` con la lista y el app sigue;
corríjalo a mano.

**Identidad.** Quien crea `schema_migrations` y ejecuta DDL tiene que ser el dueño de las
tablas. Si el app arranca con el service principal en una base creada por otra identidad, y
el schema 1.x ya está completo, el app sigue funcionando y registra
`migrations: no privilege to record the schema version`. En ese caso, ejecute `up` una vez
como el dueño (abajo). Si hay una migración nueva pendiente y el SP no puede aplicarla, el
error aparece. Un `permission denied` hace que el app reintente con la identidad del
usuario, como en el flujo de GRANTs de §6.5. Un `must be owner` (ALTER de quien no es dueño)
hace fallar la petición: ejecute `up` como el dueño antes de liberar la versión.

**Por línea de comandos.** `scripts/migrate.mjs` usa las variables estándar de Postgres
(`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`) y los mismos
`PG_SSL_CA`/`PG_SSL_REJECT_UNAUTHORIZED` del app. En el Lakebase, use como `PGPASSWORD` una
credencial de base del dueño de las tablas (`databricks database generate-database-credential`).
El token de la CLI no se acepta. Cada comando imprime primero el destino
(`target: <host>:<puerto>/<base> as <usuario>`): revíselo antes de seguir, sobre todo si el
`.env.local` apunta al mismo Lakebase del app.

```bash
# qué está aplicado, pendiente o alterado (sale con 1 si un archivo aplicado cambió)
node scripts/migrate.mjs status

# upgrade: aplica las pendientes (lo mismo que hace el arranque)
node scripts/migrate.mjs up

# rollback: deshace, de la más nueva a la más antigua, toda versión por encima de N
# (sin --yes solo muestra el destino y se detiene)
node scripts/migrate.mjs down --to <N> --yes

# base local de desarrollo
node --env-file=.env.local scripts/migrate.mjs status
```

`down --to 0` deshace el `0001_baseline`, es decir, **borra todas las tablas y los datos del
app**, y al final borra la propia `schema_migrations`: el schema queda vacío. Úselo solo en
una base de prueba o de CI. En producción, el rollback de schema es de
una migración específica y planificada (§6.2).

**Archivo modificado después de aplicado.** El runner guarda el SHA-256 de cada `.up.sql`
aplicado (los finales de línea CRLF y el BOM no cuentan). Si el archivo cambió, el arranque
y el `up` se detienen con `migrations: applied file changed … [MIGRATION_CHECKSUM]` y no se
ejecuta nada más: dos bases con la misma versión y schemas distintos serían peores que un
app detenido. Restaure el archivo de la release y ponga el cambio en una migración nueva.

**Cambios de schema (desarrolladores).** Nunca edite un archivo ya publicado ni ponga DDL en
`server/db.js`. Cree el número siguiente (`0002_<nombre>.up.sql` y `.down.sql`) con el `down`
probado: `server/migrate.test.js` muestra la prueba de ida y vuelta en una base temporal.
Las consultas de una feature nueva van en `server/db/<feature>.js`, usando `withClient` o
`withTx` (transacción) de `server/db/pool.js`.

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
