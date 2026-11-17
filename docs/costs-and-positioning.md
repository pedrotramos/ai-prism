# AI Prism costs and positioning

**English** · [Português (Brasil)](pt-BR/costs-and-positioning.md)

> **Important notice.** AI Prism is **not an official Databricks product**. It
> has **no SLA**, no official support, and no contractual guarantees. It is an
> open-source **solution accelerator**. Its purpose is to give you, in your own
> Databricks workspace, a first-class interface for talking to the leading models
> on the market, with the assurance that **your data is not used to train
> third-party models**, because everything runs inside your Databricks account.
> Treat it as a starting point that you control and customize, not as a managed
> service.

This document explains openly **how AI Prism consumes Databricks resources**
(this is how it is "charged"), and why this model tends to be more advantageous
than closed, subscription-based products.

---

## 1. How AI Prism is charged: Databricks resource consumption

AI Prism has no price of its own and no license. You pay **only for the
Databricks resources it uses in your workspace**, on a *pay-per-use* (DBU) model.
There is no fixed monthly seat fee. There are four components, and the first one
is by far the largest:

| Component | What it is | How it is measured | Order of magnitude |
|---|---|---|---|
| **Model Serving (AI Gateway)** | Calls to the LLMs (chat + embeddings) | Tokens → DBU, billed per provider SKU | **~US$ 0.07 / DBU** for Anthropic, OpenAI, and Google through AI Gateway |
| **Lakebase (Postgres)** | Sessions, messages, templates, RAG embeddings | Serverless Database (DBU per compute time) | ~US$ 0.52 / DBU (us-west; varies by region) |
| **SQL Warehouse** | Cost dashboard (system tables) + tools (UC Functions) | Serverless SQL (DBU) | ~US$ 0.70 / DBU |
| **Databricks Apps** | The runtime that serves the Node UI and server | App compute | Small and constant |

> The values above are **list prices** read live from
> `system.billing.list_prices`. They can vary by account, region, and negotiated
> discounts. The **AI Costs dashboard** (AI/BI, provisioned by the bundle) shows
> the **actual billed cost** (DBU × your account's price), not estimates.

**In practice, ~95%+ of the cost is Model Serving.** You pay essentially for
actual model use, in proportion to token volume. A user who asks a few questions
costs cents. The cost scales with usage, not with the number of licenses.

### What AI Prism does NOT cost
- **No platform fee or seat fee**: there is no monthly charge per user.
- **No markup**: AI Prism adds no margin on top of the models. You pay Databricks
  the serving price, directly.
- **No meaningful idle cost**: apart from the small App compute, serverless
  resources bill only when they are used.

### Built-in transparency
The bundle provisions an **AI Costs dashboard** (AI/BI, opened in the workspace;
see [`dashboards/`](../dashboards/)). It reads the Databricks *system tables*
through a SQL Warehouse, **without adding load to the app's database**. It shows,
by user, model, and period: the actual cost in USD, the DBUs consumed, and the
tokens (including tokens served from cache). Auditing who spent what is a screen,
not a data project.

In the app itself, each user sees a **cost meter** in the header. It shows the
month's spend and the cost of the open conversation, updated at the end of each
response. The two serve different purposes:

| | Cost meter (in the app) | AI Costs dashboard |
|---|---|---|
| Who it is for | Each user, about their own usage | Admins and FinOps, about the whole organization |
| Source | `usage_ledger` in Lakebase, one row per gateway call | System tables (`serving.endpoint_usage` + `billing`) |
| Value | Estimate at the vendor's **list price** | **Billed cost** (DBU × your account's price) |
| Delay | Immediate | ~1 h |

The cost meter counts every call the app makes on the user's behalf, including
the "invisible" ones: the intent router, conversation titles, the embeddings for
search and memory, media transcription, images, and AI edits in the studios.
Negotiated discounts do not appear there, so the official number is still the one
in the dashboard.

The app **does not enforce spending limits**. For budgets, alerts, and consumption
caps, use the **native Databricks budgets** (account console, under *Usage →
Budgets*, and serverless budget policies; see your cloud's documentation). Combine
them with the app's usage tags (`usage_context['application']='ai-prism'`). For a
lightweight per-person alert, create a **Databricks SQL alert** on the
`ai_prism_detail` dataset in the [cost dashboard](../dashboards/README.md). It
flags spend per user above a USD amount. The dashboard lags by about 1 h.

---

## 2. Why this model is advantageous

Compare the AI Prism model (deployed in your workspace, pay-per-use) with the
closed offerings on the market:

| Dimension | AI Prism in your workspace | Anthropic Claude / OpenAI ChatGPT Enterprise / Perplexity Enterprise |
|---|---|---|
| **Where the data lives** | In **your** Unity Catalog / Databricks workspace | In the vendor's infrastructure |
| **Use of your data for training** | **No.** Inference runs inside your Databricks account | Depends on the vendor's policy. Historically a recurring concern |
| **Available models** | **Multi-model**: Claude, GPT, Gemini, Llama, and open models. Switch from a dropdown | Locked to the vendor's model (Claude → Anthropic, GPT → OpenAI) |
| **Price** | Pay-per-use (DBU), in proportion to usage | Per-seat subscription (typically US$ 20–60 per user per month), paid even when unused |
| **Lock-in** | **None.** Open source that you control and customize | Closed platform. Migrating means rewriting |
| **Customization** | The UI and features are yours to adapt | Limited to what the vendor exposes |
| **Governance** | Inherits Databricks permissions, audit, and billing | A separate vendor dashboard |

### The core argument
Closed tools charge **per seat, every month, regardless of use**. They also lock
you to **a single model provider** and to its infrastructure. AI Prism reverses
that. You deploy **in your own workspace**, pay **only for what you consume**,
choose **any frontier model** for each task, and keep **data and governance inside
your account**. It is the difference between *renting a closed product* and
*owning your own AI platform*, with the convenience of coming ready to use.

### What makes the offering unique
- **Real multi-model** in one place: Claude, GPT, Gemini, Llama, and open models,
  with instant switching and a catalog that admins can curate.
- **Rich artifacts**: generation of **decks (native .pptx)** and **spreadsheets
  (.xlsx with charts)** that match your brand's **design system**.
- **Workspace tools**: Genie Agents, Unity Catalog Functions, and Vector Search as
  chat *tools*, with the user's own identity and permissions.
- **History RAG** (pgvector in Lakebase) for semantic memory across conversations.
- **Native governance and cost**: AI cost auditing per user, straight from the
  *system tables*, and data isolation by identity.
- **Open and customizable**: the UI and features are yours to extend.

---

## 3. How to reduce cost without losing quality

- **Choose the right model for the task**: the app already exposes fast, inexpensive
  models alongside the frontier ones. Not every question needs Opus or Astra.
  Reference list prices of the curated models (US$ per 1M tokens, input / output,
  checked in Nov 2026):

  | Tier | Models |
  |---|---|
  | Economy | Claude Haiku 5.5 and GPT-6 Luna (0.10 / 0.50) · GLM-5.3 Flash (0.15 / 0.50) · Gemini 3.8 Flash (0.75 / 3.75) |
  | Everyday | GPT-6.1 Terra (1 / 5) · GLM-5.3 (1.40 / 4.40) · Claude Sonnet 5.5 and GPT-6.1 Sol (2 / 10) · Kimi K3 (3 / 15) |
  | Frontier | Claude Opus 5.5 and Gemini 4 Argon (4 / 20) · Claude Fable 5.1 and GPT-6 Astra (10 / 50) |

  These are the vendors' list prices, used for the estimates in the UI. The billed
  amount is the one in the cost dashboard. Admins can override any price in the
  *Models (LLM)* tab.
- **Prompt caching**: Claude endpoints honor caching of the stable prompt prefix.
  The cost dashboard shows the *cached tokens*, which cost much less.
- **Workspace budgets**: spending limits and alerts live in the native Databricks
  budgets, not in the app. Each person tracks their own usage on the cost meter.
- **Model curation**: admins can enable only the models they want in the catalog,
  which avoids accidental use of the most expensive ones. The default list is the
  current generation. The previous one stays off, but it is one click away in
  *Add model*.
- **Context window + RAG**: the app already limits the history it sends, and it
  retrieves only what is relevant. This cuts input tokens in long conversations.

---

*This material describes AI Prism as an open-source solution accelerator on the
Databricks platform. Databricks resource prices are set by Databricks and vary by
account and region. Always confirm them in your own billing.*
