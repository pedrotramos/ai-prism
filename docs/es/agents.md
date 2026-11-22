<!-- i18n: source=docs/agents.md source-hash=2e87eefb475fd6a006e3c4c7921cd34c11584e70 status=machine -->
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
`409 conflict`), eliminar, `submit`, `enable`, `disable`, `run`, `runs`. Un registro que no es del solicitante responde
`404 not_found`, exactamente como uno que no existe.

Administradores (`/api/admin/agents`): la cola de revisión con el hash actual y la identidad de cada herramienta,
`approve` (`expectedHash`, `days` opcional), `reject` (`reason`), `revoke` y `settings` (lectura y escritura).

Los errores llevan un código estable en `error` y en `code`; la interfaz lo traduce. Errores de ejecución que
desactivan la programación de inmediato: `approval_expired`, `approval_changed`, `tool_not_admitted`,
`model_not_allowed`, `sp_model_denied`, `sp_no_user_credentials`, `sp_permission_denied`. Tres fallos transitorios
seguidos (`sp_unavailable`, `gateway_error`, `timeout`, `lease_lost`, `lease_expired`, `db_error`) también la
desactivan.
