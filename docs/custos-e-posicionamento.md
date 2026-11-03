# Custos do AI Prism e como ele se posiciona

> **Aviso importante.** O AI Prism **não é um produto oficial da Databricks** e
> **não tem SLA**, suporte oficial nem garantias contratuais. É um **acelerador
> de solução** de código aberto: a ideia é empoderar você a ter, no seu próprio
> workspace Databricks, uma interface de primeira linha para conversar com os
> principais modelos do mercado — com a tranquilidade de que **seus dados não são
> usados para treinar modelos de terceiros**, porque tudo roda dentro da sua
> conta Databricks. Trate-o como um ponto de partida que você controla e
> customiza, não como um serviço gerenciado.

Este documento é transparente sobre **como o AI Prism consome recursos da
Databricks** (é assim que ele é "cobrado"), e por que esse modelo tende a ser
vantajoso frente a assinaturas fechadas de mercado.

---

## 1. Como o AI Prism é cobrado: consumo de recursos Databricks

O AI Prism não tem preço próprio nem licença. Você paga **exatamente os recursos
Databricks que ele usa no seu workspace**, no modelo *pay-per-use* (DBU) — nada
de assento fixo mensal. São quatro componentes, e o maior de longe é o primeiro:

| Componente | O que é | Como é medido | Ordem de grandeza |
|---|---|---|---|
| **Model Serving (AI Gateway)** | As chamadas aos LLMs (chat + embeddings) | Tokens → DBU, faturado por SKU do provedor | **~US$ 0,07 / DBU** para Anthropic, OpenAI e Google via AI Gateway |
| **Lakebase (Postgres)** | Sessões, mensagens, templates, embeddings do RAG | Database Serverless (DBU por tempo de compute) | ~US$ 0,52 / DBU (us-west; varia por região) |
| **SQL Warehouse** | Dashboard de custos (system tables) + tools (UC Functions) | Serverless SQL (DBU) | ~US$ 0,70 / DBU |
| **Databricks Apps** | O runtime que serve a UI/servidor Node | Compute da App | Pequeno e constante |

> Os valores acima são **preços de tabela** lidos ao vivo de
> `system.billing.list_prices` (podem variar por conta, região e descontos
> negociados). O **dashboard de Custos de IA** (AI/BI, provisionado pelo bundle)
> mostra o **custo real faturado** (DBU × preço da sua conta), não estimativas.

**Na prática, ~95%+ do custo é Model Serving** — ou seja, você paga essencialmente
pelo uso real dos modelos, proporcional ao volume de tokens. Um usuário que faz
poucas perguntas custa centavos; o custo escala com o uso, não com o número de
licenças.

### O que o AI Prism NÃO custa
- **Sem taxa de plataforma / assento**: não há mensalidade por usuário.
- **Sem markup**: o AI Prism não adiciona margem sobre os modelos — você paga a
  Databricks o preço de serving, direto.
- **Sem custo ocioso relevante**: fora um compute pequeno da App, os recursos
  serverless só faturam quando são usados.

### Transparência embutida
O bundle provisiona um **dashboard de Custos de IA** (AI/BI, aberto no workspace —
ver [`dashboards/`](../dashboards/)) que lê as *system tables* da Databricks via SQL
Warehouse — **sem onerar o banco do app** — e mostra, por usuário / modelo / período:
custo real em USD, DBU consumido e tokens (inclusive tokens servidos por cache).
Auditar quem gastou o quê é uma tela, não um projeto de dados.

---

## 2. Por que esse modelo é vantajoso

Compare o modelo do AI Prism (deploy no seu workspace + pay-per-use) com as
ofertas fechadas de mercado:

| Dimensão | AI Prism no seu workspace | Anthropic Claude / OpenAI ChatGPT Enterprise / Perplexity Enterprise |
|---|---|---|
| **Onde os dados ficam** | No **seu** Unity Catalog / workspace Databricks | Na infraestrutura do fornecedor |
| **Uso dos seus dados p/ treino** | **Não** — inferência dentro da sua conta Databricks | Depende da política do fornecedor; historicamente uma preocupação recorrente |
| **Modelos disponíveis** | **Multi-modelo**: Claude, GPT, Gemini, Llama, e abertos — troca por dropdown | Preso ao modelo do fornecedor (Claude→Anthropic, GPT→OpenAI) |
| **Preço** | Pay-per-use (DBU), proporcional ao uso | Assinatura por assento (US$ 20–60/usuário/mês típico), pago mesmo sem uso |
| **Lock-in** | **Nenhum** — código aberto que você controla e customiza | Plataforma fechada; migrar é reescrever |
| **Customização** | UI e features são suas para adaptar | Limitada ao que o fornecedor expõe |
| **Governança** | Herda permissões, auditoria e billing do Databricks | Painel separado do fornecedor |

### O argumento central
Ferramentas fechadas cobram **por assento, todo mês, independentemente de uso**, e
te prendem a **um único provedor de modelo** e à infraestrutura dele. O AI Prism
inverte isso: você deploya **no seu próprio workspace**, paga **só o que
consumir**, escolhe **qualquer modelo de fronteira** conforme a tarefa, e mantém
**dados e governança dentro da sua conta**. É a diferença entre *alugar um
produto fechado* e *ter a sua própria plataforma de IA* — com a conveniência de
já vir pronta para usar.

### Features que tornam a oferta única
- **Multi-modelo real** num só lugar: Claude, GPT, Gemini, Llama e abertos, com
  troca instantânea e catálogo curável por admin.
- **Artefatos ricos**: geração de **decks (.pptx nativo)** e **planilhas (.xlsx
  com gráficos)** aderentes ao **design system** da sua marca.
- **Ferramentas do workspace**: Genie Agents, Unity Catalog Functions e Vector
  Search como *tools* do chat, com a identidade e as permissões do próprio
  usuário.
- **RAG do histórico** (pgvector no Lakebase) para memória semântica das
  conversas.
- **Governança e custo nativos**: auditoria de custo de IA por usuário, direto
  das *system tables*, e isolamento de dados por identidade.
- **Aberto e customizável**: a UI e as features são suas para estender.

---

## 3. Como reduzir custo sem perder qualidade

- **Escolha o modelo certo para a tarefa**: o app já expõe modelos rápidos e
  baratos ao lado dos de fronteira. Nem toda pergunta precisa de Opus ou Astra.
  Referência dos preços de lista curados (US$ por 1M tokens, entrada / saída,
  conferidos em nov/2026):

  | Faixa | Modelos |
  |---|---|
  | Econômicos | Claude Haiku 5.5 e GPT-6 Luna (0,10 / 0,50) · GLM-5.3 Flash (0,15 / 0,50) · Gemini 3.8 Flash (0,75 / 3,75) |
  | Dia a dia | GPT-6.1 Terra (1 / 5) · GLM-5.3 (1,40 / 4,40) · Claude Sonnet 5.5 e GPT-6.1 Sol (2 / 10) · Kimi K3 (3 / 15) |
  | Fronteira | Claude Opus 5.5 e Gemini 4 Argon (4 / 20) · Claude Fable 5.1 e GPT-6 Astra (10 / 50) |

  São preços de tabela dos fornecedores, usados na estimativa da UI; o valor
  faturado é o do dashboard de custos. O admin pode sobrescrever qualquer preço
  na aba *Modelos (LLM)*.
- **Prompt caching**: os endpoints Claude honram cache do prefixo estável — o
  painel de custos mostra os *tokens em cache*, que saem muito mais barato.
- **Curadoria de modelos**: admins podem habilitar só os modelos desejados no
  catálogo, evitando uso acidental dos mais caros. A lista default é a geração
  atual; a anterior fica desligada, mas a um clique no *Add model*.
- **Janela de contexto + RAG**: o app já limita o histórico enviado e recupera
  só o que é relevante, cortando tokens de entrada em conversas longas.

---

*Este material descreve o AI Prism como acelerador de solução open-source sobre a
plataforma Databricks. Preços de recursos Databricks são de responsabilidade da
Databricks e variam por conta/região; confirme sempre no seu próprio billing.*
