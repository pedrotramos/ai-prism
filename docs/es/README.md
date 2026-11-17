<!-- i18n: source=docs/README.md source-hash=d1c0e093986c0dc4e5cf2db4d255f15675f609aa status=machine -->
# Documentación

[English](../README.md) · [Português (Brasil)](../pt-BR/README.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../README.md) es la referencia.

Todas las guías de AI Prism, por tarea. El texto de referencia es el inglés; el
[estado de las traducciones](../i18n-status.md) muestra qué páginas existen en
portugués y español y si están al día. La mayoría de las páginas todavía no tiene
versión en español: los enlaces llevan a la versión en inglés y, en algunos casos,
a páginas que por ahora solo están en portugués.

## Despliegue y operación

- [Onboarding y despliegue](../onboarding-deployment.md) (en inglés): de un workspace vacío a la app funcionando, en pocos comandos (`bundle deploy` + `apps deploy` + `bundle run`).
- [Costos y posicionamiento](../costs-and-positioning.md) (en inglés): qué recursos de Databricks consume AI Prism y por qué el modelo conviene.
- [Operación](operations.md): salud, logs, SLOs propuestos y el runbook de despliegue, rollback y diagnóstico.
- [Tags de recursos y atribución de costos](../tags.md) (en portugués por ahora): cómo la app etiqueta lo que crea en el workspace.
- [Gobernanza de flota](../fleet-governance.md) (en portugués por ahora): dueño, nombres, guardrails, atribución de costos y retiro de varias instalaciones.
- [Dashboards de costos y operación (AI/BI)](../../dashboards/README.md) (en inglés): auditoría de costos de IA, volumen de uso y latencia del gateway a partir de las system tables.

## Seguridad

- [Política de seguridad](../../SECURITY.md) (en inglés): cómo reportar una vulnerabilidad y qué controles tiene la app.
- [FAQ de seguridad](../security-faq.md) (en inglés): respuestas a las objeciones habituales de una revisión, separando lo que hace la app y lo que hace la plataforma.
- [Modelo de amenazas](../security-threat-model.md) (en portugués por ahora): activos, actores, fronteras de confianza, controles y brechas declaradas.

## Integraciones

- [Conectar servidores MCP](../mcp-connections.md) (en portugués por ahora): registrar un MCP Service en Unity AI Gateway, publicarlo en el catálogo MCP de la app y conectarlo dentro de AI Prism.
- [Microsoft 365 con Microsoft Graph](../mcp-microsoft-graph.md) (en portugués por ahora): correo y calendario sin licencia de Copilot Studio Pro, con un servidor MCP propio sobre Graph.
- [Búsqueda y lectura web](../web-search.md) (en portugués por ahora): las dos tools web nativas y cómo desactivarlas.

## Desarrollo

- [Contribuir](CONTRIBUTING.md): flujo de desarrollo, pruebas y QA, convenciones de commits y pull requests.
- [Rendimiento y carga](../performance.md) (en portugués por ahora): cómo funciona `npm run loadtest` y el `EXPLAIN` de las consultas críticas.
- [Registros de decisiones de arquitectura](../adr/README.md) (en portugués por ahora): un archivo por decisión. Los ADR no se traducen; pasan al inglés en una fase siguiente.
- [Glosario](../glossary.md): las palabras de la propia app en inglés, portugués y español, generadas a partir de los catálogos de la interfaz.

## Traducciones

El inglés es la versión canónica. Una traducción replica la ruta del inglés en
`docs/<locale>/` (`docs/es/operations.md` traduce `docs/operations.md`;
`SECURITY.md` y `CONTRIBUTING.md` pasan a ser `docs/<locale>/SECURITY.md` y
`docs/<locale>/CONTRIBUTING.md`). La excepción es el README de la raíz:
`README.pt-BR.md` y `README.es.md`. La lista de páginas traducidas y de las que
faltan está en [i18n.json](../i18n.json).

La línea 1 de cada traducción registra la versión en inglés a la que corresponde:

```md
<!-- i18n: source=docs/operations.md source-hash=<git blob sha of the English file> status=current -->
```

- `current`: corresponde a esa versión en inglés.
- `outdated`: el inglés cambió y la traducción se marcó a propósito; la página muestra un aviso que apunta al inglés.
- `machine`: traducción hecha con ayuda de IA que espera revisión nativa; también muestra un aviso.
- `stub`: un texto corto provisional que apunta al inglés.

`scripts/check-docs-i18n.mjs` falla cuando el inglés cambia y una traducción todavía
dice `current`, cuando los títulos, tablas o bloques de código no coinciden, cuando un
bloque de código difiere en algo más que los comentarios, cuando se rompe un enlace
relativo o un ancla, o cuando falta el selector de idioma debajo del título. Cuando
cambies una página en inglés:

```bash
node scripts/check-docs-i18n.mjs                     # qué está desincronizado
node scripts/check-docs-i18n.mjs --stamp docs/pt-BR/operations.md                    # después de actualizar la traducción
node scripts/check-docs-i18n.mjs --stamp docs/es/operations.md --status outdated     # cuando no pudiste actualizarla
node scripts/check-docs-i18n.mjs --report            # regenera docs/i18n-status.md
node scripts/check-docs-i18n.mjs --glossary          # regenera docs/glossary.md después de cambiar un texto de la interfaz
```

Los bloques de código quedan idénticos byte a byte en todos los idiomas: traduce solo
los comentarios. Cuando un bloque tiene texto que hay que traducir (las etiquetas de
un diagrama, por ejemplo), pon `<!-- i18n: code-translated -->` en la línea anterior a
la cerca de apertura, en todos los idiomas. Para borradores hechos con ayuda de IA,
usa la guía de estilo del idioma ([pt-BR](../pt-BR/.llm-prompt.md), [es](.llm-prompt.md))
junto con el [glosario](../glossary.md), y pide la revisión de un hablante nativo antes
de que el estado pase a `current`.
