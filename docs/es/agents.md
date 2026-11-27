<!-- i18n: source=docs/agents.md source-hash=565c9f1d8e803b9e61b49ac854301d5f2e048f12 status=machine -->
# Agentes programados

[English](../agents.md) · [Português (Brasil)](../pt-BR/agents.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../agents.md) es la referencia.

Un agente programado es un prompt guardado que AI Prism ejecuta por sí solo, en un horario definido, sin nadie frente
al teclado. Cada ejecución crea un chat nuevo en el historial del dueño, con la respuesta y cualquier deck, hoja de
cálculo o documento que haya producido.

La funcionalidad viene **desactivada**. Esta página explica como quién actúa una ejecución sin supervisión y a qué datos
llega, porque esa es la decisión que toma el administrador al aprobar un agente.

## Cómo activarla

Dos interruptores, los dos son necesarios:

1. El operador define `AGENTS_ENABLED=1` en el entorno de la app (`app.yaml`) y vuelve a desplegar. Sin eso las rutas
   responden `404 agents_disabled`, no se inicia ningún programador y la interfaz queda oculta.
2. Un administrador activa los agentes en Configuración (el ajuste `agents_enabled`). Mientras esté desactivado, un
   agente aún puede escribirse y enviarse a aprobación, pero no puede habilitarse y "ejecutar ahora" se rechaza.

Para revertir, desactive el ajuste (suave) y luego quite `AGENTS_ENABLED` y vuelva a desplegar (completo). Ambos
caminos conservan todas las definiciones y el historial de ejecuciones.

Los administradores también definen, en el mismo lugar:

| Ajuste | Predeterminado | Rango | Significado |
|---|---|---|---|
| `agents_max_run_cost_usd` | 1.0 | 0.05 – 50 | Una ejecución que alcanza este costo se detiene en la siguiente llamada al modelo; la respuesta hasta ese punto se conserva, con un aviso. |
| `agents_approval_days` | 90 | 1 – 365 | Cuánto dura una aprobación. Después, el agente se detiene y el dueño debe volver a enviarlo. |

Cada cambio de ajustes y cada decisión escribe una fila en la auditoría de administración.

## Programaciones

Un agente se ejecuta con la programación que eliges en **Repetir**: cada hora, todos los días, días hábiles, cada
semana o cada mes, con la hora (y el día), una **zona horaria** y la vista previa de las **próximas tres
ejecuciones**, calculadas por el servidor en esa zona (una hora que no existe en un día de cambio de horario se
ejecuta en el primer instante válido; una que ocurre dos veces se ejecuta una vez).

**Personalizado (avanzado).** Para lo que las cinco opciones no dicen (dos veces al día, lunes-miércoles-viernes,
los días 1 y 15), elige **Personalizado (avanzado)** y escribe un cron estándar de cinco campos:
`minuto hora día-del-mes mes día-de-la-semana`, con listas (`1,3,5`), rangos (`1-5`), pasos (`*/2`), nombres
`JAN-DEC` y `SUN-SAT` y los atajos `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. Cuando los dos campos de
día están restringidos, un día vale si coincide con cualquiera de ellos, como en el cron de Vixie. El editor parte del
cron de la opción que tenías, muestra las próximas tres ejecuciones mientras escribes y dice por qué se rechaza un
cron: número de campos incorrecto, un valor fuera de rango, ninguna fecha real (`0 0 31 2 *`) o **más de una vez por
hora** (un agente nunca se ejecuta con más frecuencia que la opción cada hora). Un cron que una de las cinco opciones
ya cubre se guarda como esa opción, así que dos formas de escribir "cada lunes a las 08:00" son una sola definición.
El cron personalizado es parte de lo que aprueba el administrador: editarlo, o la zona horaria, anula la aprobación
como cualquier otra edición. Se guarda en una única grafía canónica (`MON-FRI`, `mon-fri` y `1,2,3,4,5` se guardan
todos como `1-5`, y `7` como `0`), así que las reescrituras comunes nunca cambian la aprobación (una lista de días que empieza por `*` y no es un paso
simple, como `*/2,MON`, conserva su propia grafía: reescribirla cuenta como edición), y la pantalla de
revisión le muestra al administrador lo que significa: la descripción y las próximas tres ejecuciones, con un aviso
cuando los dos campos de día están definidos (`0 9 1,15 * 1` se ejecuta los días 1 y 15 **y** todos los lunes). Se
acepta una fecha rara pero real: `0 0 29 2 *` se ejecuta cada 29 de febrero y `0 0 29 2 */7` los 29 de febrero que
caen en domingo (2032, 2060, 2088).

**Horario de verano.** Un cron personalizado sigue las mismas reglas que las cinco opciones: una hora local que no
existe ese día se ejecuta en el primer instante válido tras el salto, y una que ocurre dos veces se ejecuta una vez,
en su primera aparición. La regla "no más de una vez por hora" se comprueba en el reloj de pared, así que el día en
que los relojes se adelantan `30 1,2 * * *` se ejecuta a las 03:00 por segunda vez, 30 minutos después de la primera
(las 02:30 no existen). No es una garantía de una hora entre ejecuciones ese único día; un agente sigue sin
ejecutarse nunca dos veces a la vez.

### Cómo espera el programador

El programador no hace polling. Lee la base de datos, reclama lo que vence y luego duerme hasta lo primero entre la
próxima ejecución programada, una ejecución manual en cola y el fin del lease de una ejecución en curso. También
vuelve a consultar como máximo cada **6 horas** (`AI_PRISM_SCHEDULER_MAX_SLEEP_MS`, de 1 segundo a 24 horas; el
nombre antiguo `AGENT_SCHEDULER_MAX_SLEEP_MS` todavía se lee) y poco después de que arranca la app. Aprobar, activar,
desactivar o eliminar un agente y poner una ejecución en cola lo despiertan al instante, en el proceso que atendió la
solicitud. Entre esos momentos no hace ninguna consulta, así que las conexiones de la app se cierran (2 minutos
inactivas) y Lakebase puede escalar a cero entre ejecuciones.

Lo que conviene saber:

- Varias réplicas se reparten el trabajo con los mismos locks de antes: un horario se reclama una vez, sea cual sea la
  réplica que despierte primero.
- Un cambio hecho en una réplica llega a las demás por el uso de la app. Mientras alguien la usa, la base de datos ya
  está despierta, así que una réplica que no ha mirado las programaciones en 5 minutos vuelve a mirar en su próxima
  solicitud autenticada. La garantía: mientras la app está en uso, una programación guardada en una réplica que luego
  se detiene la ve otra en unos 5 minutos, bien dentro de la hora de tolerancia, y el horario se ejecuta. Con la app
  inactiva nada despierta a las demás réplicas antes de su próxima ejecución, la revisión de 6 horas o su arranque,
  así que un horario guardado justo antes de que se detuviera la última réplica que lo conocía puede reclamarse con
  retraso y, si pasa de una hora, registrarse como `missed`. Un cambio hecho mientras la propia réplica está ocupada
  nunca se pierde: si un administrador activa los agentes mientras lee el ajuste, planifica de nuevo desde la base de
  datos en vez de dormir sobre una respuesta vieja.
- Una ejecución cuya hora pasó sin ninguna réplica despierta (la app estaba detenida) se reclama con retraso si tiene
  menos de una hora y, si no, se registra como **omitida** con el código `missed`. Las ejecuciones perdidas nunca se
  repiten: el siguiente horario cuenta desde ahora.
- Una fila de ejecución puede seguir en `running` después de que su app murió hasta que el lease (120 s) venza **y**
  una réplica despierte (en unos 5 minutos con la app en uso, hasta el sueño máximo cuando está inactiva); reduce
  `AI_PRISM_SCHEDULER_MAX_SLEEP_MS` si eso te importa más que el tiempo ocioso de Lakebase.

## Ciclo de vida de un agente

1. El dueño escribe el agente (instrucciones, prompt, modelo, herramientas, programación opcional) y lo guarda como
   **borrador**. Cada dueño puede tener 10 agentes.
2. El dueño lo **envía**. Pasa a **pendiente**.
3. Un administrador revisa la definición y **aprueba**, **rechaza** (con un motivo) o, más adelante, **revoca**. La
   pantalla envía el hash de la definición que mostró; si el dueño editó el agente entretanto, la aprobación se rechaza
   con `409` y no se escribe nada, de modo que el administrador nunca aprueba algo que no leyó.
4. El dueño **habilita** la programación. Se rechaza salvo que el agente esté aprobado, la aprobación no haya vencido y
   el ajuste esté activado. Habilitar calcula la próxima ejecución a partir de la programación y su zona horaria.
5. **Ejecutar ahora** pone en cola una ejecución manual de un agente aprobado. Mientras haya una ejecución en cola o en
   curso, otra se rechaza con `409 busy`.

**Cualquier edición de lo que el administrador aprobó anula la aprobación.** La propia base de datos devuelve el agente
a borrador y lo desactiva en la misma sentencia, así que ninguna ruta puede olvidarlo. Solo el nombre y la descripción
cambian sin nueva aprobación. Una ejecución siempre corre la instantánea aprobada, nunca la fila en edición, y comprueba
al inicio que la aprobación siga vigente.

## Como quién actúa una ejecución sin supervisión

| Parte de la ejecución | Identidad |
|---|---|
| El gateway de modelos, cada herramienta y cada llamada MCP | **El service principal de la app**, no el dueño |
| El chat, sus mensajes y artefactos, el registro de uso | El **dueño**: las filas son suyas, como si hubiera enviado el mensaje |
| El registro de que la ejecución empezó y terminó | Un actor de sistema en la auditoría de administración (solo códigos e ids, sin correo ni texto) |

La ejecución usa el service principal porque no hay nadie que inicie sesión: el token del usuario solo existe mientras
está en la app.

### Qué puede hacer

- Crear un chat nuevo del dueño, con el nombre del agente y la hora de la ejecución en el título.
- Escribir los mensajes, las llamadas a herramientas y los artefactos de ese chat.
- Leer la plantilla de deck y el modelo de imagen que el dueño tiene seleccionados.
- Llamar al modelo y a las herramientas que el administrador aprobó.

### Qué no puede hacer

- Leer los otros chats del dueño: la ejecución empieza en un chat nuevo y vacío, y la búsqueda en el historial entre
  chats no se usa.
- Leer o escribir las memorias del dueño, ni usar el contexto de proyectos.
- Usar cualquier credencial por usuario, como una conexión MCP personal. Una ejecución que la necesite falla con
  `sp_no_user_credentials` y la programación se desactiva.
- Usar servicios MCP cuya clase de credencial sea `per_user`, `shared` o `unverified`. Solo se admite la clase
  `databricks`, y solo servicios del catálogo MCP de los administradores.
- Llamar a `web_search` mientras la política de herramientas de la organización la tenga desactivada.
- Ejecutar una definición distinta de la aprobada, ni sobrevivir a su aprobación.

## A qué datos llega una ejecución sin supervisión

Este es el punto que hay que leer antes de aprobar.

`genie_one` y las herramientas MCP de la clase `databricks` leen datos de Unity Catalog **con los permisos del service
principal, no con los del dueño**. Por lo tanto, un agente programado puede ver datos que su dueño no ve, si el service
principal recibió acceso a ellos, y no puede ver datos que el dueño sí ve, si el service principal no los recibió.

Lo que se desprende para los administradores:

- **Otorgue al service principal solo datos que todo dueño de agente pueda ver.** Trate los permisos del service
  principal como el techo de lo que cualquier agente programado puede leer.
- La pantalla de aprobación lista cada herramienta del agente y marca las que leen datos del workspace. Apruébelas
  con criterio.
- Un agente que solo usa `web_search`, `generate_image` o las herramientas de deck, hoja de cálculo y documento no lee
  datos del workspace.
- El resultado llega solo al chat del dueño. No existe canal de entrega por correo, webhook ni otro.
- Trate la salida de las herramientas como no confiable: una página o una tabla puede contener texto que intente
  conducir al agente. Por eso el conjunto de herramientas se fija en la aprobación, cada herramienta tiene el mínimo
  privilegio y la ejecución no tiene credenciales por usuario.

AI Prism no cambia ningún permiso en el workspace. Dar acceso al service principal es una decisión del operador,
tomada en Unity Catalog.

## Referencia: API HTTP

Dueños (`/api/agents`): `GET status`, listar, crear, obtener, `PATCH` (exige `revision`; una desactualizada responde
`409 conflict`), eliminar, `submit`, `enable`, `disable`, `run`, `runs`, `tool-options` (solo lectura: los tipos de herramienta y los servicios del catálogo administrados por Databricks que
puede usar un agente, con la política de herramientas de la organización aplicada) y `schedule-preview` (solo lectura: describe una programación y lista sus próximas tres
ejecuciones con las mismas funciones del programador, sin tocar ningún registro). Un registro que no es del solicitante responde
`404 not_found`, exactamente como uno que no existe.

Administradores (`/api/admin/agents`): la cola de revisión con el hash actual y la identidad de cada herramienta,
`approve` (`expectedHash`, `days` opcional), `reject` (`reason`), `revoke` y `settings` (lectura y escritura).

Los errores llevan un código estable en `error` y en `code`; la interfaz lo traduce. Errores de ejecución que
desactivan la programación de inmediato: `approval_expired`, `approval_changed`, `tool_not_admitted`,
`model_not_allowed`, `sp_model_denied`, `sp_no_user_credentials`, `sp_permission_denied`. Tres fallos transitorios
seguidos (`sp_unavailable`, `gateway_error`, `timeout`, `lease_lost`, `lease_expired`, `db_error`) también la
desactivan.
