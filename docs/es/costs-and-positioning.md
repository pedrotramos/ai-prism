<!-- i18n: source=docs/costs-and-positioning.md source-hash=43e17615ef8e29fcaeefdc3a4ef3347c83e07e3a status=machine -->
# Costos de AI Prism y su posicionamiento

[English](../costs-and-positioning.md) · [Português (Brasil)](../pt-BR/costs-and-positioning.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../costs-and-positioning.md) es la referencia.

> **Aviso importante.** AI Prism **no es un producto oficial de Databricks**. No tiene
> **SLA**, ni soporte oficial, ni garantías contractuales. Es un **acelerador de
> soluciones** de código abierto. Su propósito es darte, en tu propio workspace de
> Databricks, una interfaz de primer nivel para conversar con los modelos líderes del
> mercado, con la garantía de que **tus datos no se usan para entrenar modelos de
> terceros**, porque todo corre dentro de tu cuenta de Databricks. Tómalo como un punto
> de partida que tú controlas y personalizas, no como un servicio gestionado.

Este documento explica abiertamente **cómo AI Prism consume recursos de Databricks** (así
es como se "cobra"), y por qué este modelo tiende a ser más ventajoso que los productos
cerrados por suscripción.

---

## 1. Cómo se cobra AI Prism: consumo de recursos de Databricks

AI Prism no tiene precio propio ni licencia. Pagas **solo por los recursos de Databricks
que usa en tu workspace**, con un modelo de *pago por uso* (DBU). No hay una tarifa mensual
fija por asiento. Son cuatro componentes, y el primero es, por mucho, el más grande:

| Componente | Qué es | Cómo se mide | Orden de magnitud |
|---|---|---|---|
| **Model Serving (AI Gateway)** | Llamadas a los LLM (chat + embeddings) | Tokens → DBU, facturados por SKU de proveedor | **~US$ 0.07 / DBU** para Anthropic, OpenAI y Google a través de AI Gateway |
| **Lakebase (Postgres)** | Sesiones, mensajes, plantillas, embeddings de RAG | Serverless Database (DBU por tiempo de cómputo) | ~US$ 0.52 / DBU (us-west; varía según la región) |
| **SQL Warehouse** | Dashboard de costos (tablas del sistema) + herramientas (UC Functions) | SQL serverless (DBU) | ~US$ 0.70 / DBU |
| **Databricks Apps** | El runtime que sirve la interfaz Node y el servidor | Cómputo de la App | Pequeño y constante |

> Los valores de arriba son **precios de lista** leídos en vivo de
> `system.billing.list_prices`. Pueden variar según la cuenta, la región y los descuentos
> negociados. El **dashboard de costos de IA** (AI/BI, aprovisionado por el bundle) muestra
> el **costo facturado real** (DBU × el precio de tu cuenta), no estimaciones.

**En la práctica, más del 95% del costo es Model Serving.** Pagas básicamente por el uso
real de los modelos, en proporción al volumen de tokens. Un usuario que hace unas pocas
preguntas cuesta centavos. El costo escala con el uso, no con el número de licencias.

### Lo que AI Prism NO cuesta
- **Sin cuota de plataforma ni por asiento**: no hay un cargo mensual por usuario.
- **Sin recargo**: AI Prism no agrega margen sobre los modelos. Pagas a Databricks el precio
  de serving, directamente.
- **Sin costo ocioso relevante**: salvo el pequeño cómputo de la App, los recursos
  serverless solo se facturan cuando se usan.

### Transparencia integrada
El bundle aprovisiona un **dashboard de costos de IA** (AI/BI, se abre en el workspace; ver
[`dashboards/`](../../dashboards/)). Lee las *tablas del sistema* de Databricks a través de
un SQL Warehouse, **sin agregar carga a la base de datos de la app**. Muestra, por usuario,
modelo y período: el costo real en USD, los DBU consumidos y los tokens (incluidos los
tokens servidos desde caché). Auditar quién gastó qué es una pantalla, no un proyecto de
datos.

Dentro de la app, cada usuario ve un **taxímetro de costo** en el encabezado. Muestra el
gasto del mes y el costo de la conversación abierta, que se actualiza al final de cada
respuesta. Los dos tienen propósitos distintos:

| | Taxímetro de costo (en la app) | Dashboard de costos de IA |
|---|---|---|
| Para quién es | Cada usuario, sobre su propio uso | Admins y FinOps, sobre toda la organización |
| Fuente | `usage_ledger` en Lakebase, una fila por llamada al gateway | Tablas del sistema (`serving.endpoint_usage` + `billing`) |
| Valor | Estimación a **precio de lista** del proveedor | **Costo facturado** (DBU × el precio de tu cuenta) |
| Retraso | Inmediato | ~1 h |

El taxímetro cuenta cada llamada que la app hace en nombre del usuario, incluidas las
"invisibles": el enrutador de intención, los títulos de las conversaciones, los embeddings
para búsqueda y memoria, la transcripción de audio y video, las imágenes y las ediciones con
IA en los estudios. Los descuentos negociados no aparecen ahí, así que el número oficial
sigue siendo el del dashboard.

La app **no aplica límites de gasto**. Para presupuestos, alertas y topes de consumo, usa
los **presupuestos nativos de Databricks** (consola de la cuenta, en *Usage → Budgets*, y
las políticas de presupuesto serverless; consulta la documentación de tu nube). Combínalos
con las etiquetas de uso de la app (`usage_context['application']='ai-prism'`). Para una
alerta liviana por persona, crea una **alerta de Databricks SQL** sobre el dataset
`ai_prism_detail` del [dashboard de costos](../../dashboards/README.md). Marca el gasto por
usuario que supera un monto en USD. El dashboard se retrasa alrededor de 1 h.

---

## 2. Por qué este modelo es ventajoso

Compara el modelo de AI Prism (desplegado en tu workspace, con pago por uso) con las ofertas
cerradas del mercado:

| Dimensión | AI Prism en tu workspace | Anthropic Claude / OpenAI ChatGPT Enterprise / Perplexity Enterprise |
|---|---|---|
| **Dónde viven los datos** | En **tu** Unity Catalog / workspace de Databricks | En la infraestructura del proveedor |
| **Uso de tus datos para entrenamiento** | **No.** La inferencia corre dentro de tu cuenta de Databricks | Depende de la política del proveedor. Históricamente, una preocupación recurrente |
| **Modelos disponibles** | **Multimodelo**: Claude, GPT, Gemini, Llama y modelos abiertos. Cambia desde un desplegable | Atado al modelo del proveedor (Claude → Anthropic, GPT → OpenAI) |
| **Precio** | Pago por uso (DBU), en proporción al consumo | Suscripción por asiento (normalmente US$ 20–60 por usuario al mes), que se paga aunque no se use |
| **Dependencia (lock-in)** | **Ninguna.** Código abierto que tú controlas y personalizas | Plataforma cerrada. Migrar significa reescribir |
| **Personalización** | La interfaz y las funciones son tuyas para adaptar | Limitada a lo que expone el proveedor |
| **Gobernanza** | Hereda los permisos, la auditoría y la facturación de Databricks | Un dashboard separado del proveedor |

### El argumento central
Las herramientas cerradas cobran **por asiento, todos los meses, uses o no**. Además, te
atan a **un solo proveedor de modelos** y a su infraestructura. AI Prism invierte eso. Lo
despliegas **en tu propio workspace**, pagas **solo por lo que consumes**, eliges
**cualquier modelo de frontera** para cada tarea y mantienes **los datos y la gobernanza
dentro de tu cuenta**. Es la diferencia entre *alquilar un producto cerrado* y *tener tu
propia plataforma de IA*, con la comodidad de venir listo para usar.

### Lo que hace única la propuesta
- **Multimodelo real** en un solo lugar: Claude, GPT, Gemini, Llama y modelos abiertos, con
  cambio instantáneo y un catálogo que los admins pueden curar.
- **Artefactos ricos**: generación de **presentaciones (.pptx nativo)** y **hojas de cálculo
  (.xlsx con gráficos)** que siguen el **design system** de tu marca.
- **Herramientas del workspace**: Genie Agents, Unity Catalog Functions y Vector Search como
  *herramientas* del chat, con la identidad y los permisos propios del usuario.
- **RAG sobre el historial** (pgvector en Lakebase) para una memoria semántica entre
  conversaciones.
- **Gobernanza y costo nativos**: auditoría de costos de IA por usuario, directamente desde
  las *tablas del sistema*, y aislamiento de datos por identidad.
- **Abierto y personalizable**: la interfaz y las funciones son tuyas para extender.

---

## 3. Cómo reducir costos sin perder calidad

- **Elige el modelo adecuado para cada tarea**: la app ya expone modelos rápidos y económicos
  junto a los de frontera. No toda pregunta necesita Opus o Astra. Precios de lista de
  referencia de los modelos curados (US$ por 1M de tokens, entrada / salida, verificados en
  nov 2026):

  | Nivel | Modelos |
  |---|---|
  | Económico | Claude Haiku 5.5 y GPT-6 Luna (0.10 / 0.50) · GLM-5.3 Flash (0.15 / 0.50) · Gemini 3.8 Flash (0.75 / 3.75) |
  | Uso diario | GPT-6.1 Terra (1 / 5) · GLM-5.3 (1.40 / 4.40) · Claude Sonnet 5.5 y GPT-6.1 Sol (2 / 10) · Kimi K3 (3 / 15) |
  | Frontera | Claude Opus 5.5 y Gemini 4 Argon (4 / 20) · Claude Fable 5.1 y GPT-6 Astra (10 / 50) |

  Estos son los precios de lista de los proveedores, que se usan para las estimaciones de la
  interfaz. El monto facturado es el del dashboard de costos. Los admins pueden cambiar
  cualquier precio en la pestaña *Modelos (LLM)*.
- **Caché de prompts**: los endpoints de Claude respetan el caché del prefijo estable del
  prompt. El dashboard de costos muestra los *tokens en caché*, que cuestan mucho menos.
- **Presupuestos del workspace**: los límites de gasto y las alertas viven en los presupuestos
  nativos de Databricks, no en la app. Cada persona sigue su propio consumo en el taxímetro
  de costo.
- **Curaduría de modelos**: los admins pueden habilitar en el catálogo solo los modelos que
  quieran, lo que evita el uso accidental de los más caros. La lista por defecto es la
  generación actual. La anterior queda desactivada, pero está a un clic en *Añadir modelo*.
- **Ventana de contexto + RAG**: la app ya limita el historial que envía y recupera solo lo
  relevante. Esto reduce los tokens de entrada en conversaciones largas.

---

*Este material describe AI Prism como un acelerador de soluciones de código abierto sobre la
plataforma de Databricks. Los precios de los recursos de Databricks los fija Databricks y
varían según la cuenta y la región. Confírmalos siempre en tu propia facturación.*
