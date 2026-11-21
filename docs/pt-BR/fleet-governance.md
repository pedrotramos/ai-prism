<!-- i18n: source=docs/fleet-governance.md source-hash=15d2f4ef73ed46a35525e924e97c3d4f9840ad13 status=current -->
# Governança de várias instalações do AI Prism

[English](../fleet-governance.md) · **Português (Brasil)** · [Español](../es/fleet-governance.md)

Quando a mesma organização roda o AI Prism em mais de um workspace (ou em mais de um
ambiente, ou para mais de um time), cada instalação é independente: tem seu app, seu
Lakebase, seu warehouse, seu catálogo e seus admins. Este documento define como manter
esse conjunto sob controle: quem é dono de cada instalação, como nomear e rotular os
recursos, quais guardrails estão no bundle, como atribuir custo e como desativar uma
instalação sem deixar recurso órfão.

Para o modelo de ameaças de cada instalação, veja [security-threat-model.md](security-threat-model.md).
Para operação do dia a dia, veja [operations.md](operations.md).

---

## 1. Modelo

- **Uma instalação = um workspace (ou um ambiente) + um `databricks.yml` + um profile da CLI.**
  Não há banco, catálogo ou admin compartilhado entre instalações.
- O bundle é **cloud-agnóstico**: nenhum host está no arquivo. A instalação é escolhida
  pelo `-p <PROFILE>` e pelo `-t <target>` (`dev` ou `prod`, definidos em `databricks.yml`).
- O código é o mesmo em todas as instalações (artefatos commitados). Diferenças entre
  instalações devem vir só de variáveis do bundle (`--var`) e de recursos do workspace.

---

## 2. Dono e responsáveis

Cada instalação precisa de um registro com estes campos, mantido fora do repositório
(planilha, wiki ou o próprio inventário de recursos da organização):

| Campo | Valor esperado | Por que importa |
|---|---|---|
| Responsável técnico | Pessoa que roda `bundle deploy` e recebe os alertas | Quem responde pelo rollout e pelo smoke |
| Admin de bootstrap | E-mail gravado em `app_admins` pelo job de auto-config (`ai_prism_auto_config`) | Primeiro admin; os demais são adicionados por um admin existente |
| Responsável de custo | Pessoa ou centro de custo que paga o workspace | Recebe o relatório de custo (§5) |
| Workspace e profile | Host real e nome do profile | Evita deploy no workspace errado |
| Versão implantada | SHA do commit dos artefatos | Ver §3.5 |

**Owner (`APP_OWNER_EMAIL`).** O bundle não define essa variável, e o `app.yaml` também
não. Sem ela, nenhum usuário tem o papel de owner (`isOwner` em `server/authz.ts` é falso; a
função também lê `DATABRICKS_USER_EMAIL`, uma variável de desenvolvimento local que o
runtime do Apps não define para o app). Os admins vêm de
`app_admins`. Isso é uma escolha de desenho do projeto, não um erro, mas é preciso saber
disso antes de desenhar um processo de aprovação.

---

## 3. Nomes, rótulos e inventário

### 3.1 Nomes que o bundle cria

| Recurso | Nome (target `dev`/`prod`) | Observação |
|---|---|---|
| Bundle | `ai-prism` | Nome do bundle; o deploy de `dev` usa prefixo de desenvolvimento do próprio CLI |
| App | `ai-prism` | Nome do app no workspace; é o alvo de `apps deploy` |
| Projeto Lakebase | `ai-prism` (branch `production`, endpoint `primary`) | Um projeto por instalação |
| SQL Warehouse | `ai-prism` | 2X-Small, serverless |
| Job de auto-config | `ai-prism-auto-config` | Roda por `bundle run` |
| Dashboards | `AI Prism — AI costs per user` e `AI Prism — Operations` | Declarados em `databricks.yml` (`ai_prism_costs`, `ai_prism_ops`) |
| Catálogo | `ai_prism` (padrão de `image_volume_catalog` e `tools_catalog`) | Compartilhado por UDF e Volume dentro da instalação |
| Volume de imagens | `ai_prism.default.ai_prism_images` | Padrão do bundle |

Para várias instalações **no mesmo metastore**, o catálogo `ai_prism` é um conflito: uma
segunda instalação não pode criá-lo. Defina `image_volume_catalog` e `tools_catalog`
com um nome por instalação (ex.: `ai_prism_<time>`) e passe com `--var`.

### 3.2 Tags

O bundle rotula o que cria, e o app rotula o próprio uso. O operador passa as tags uma vez no
deploy (`resource_tags`, `resource_tags_list`, `resource_tags_json` em `databricks.yml`;
`deploy.sh --tag k=v`). O guia completo, com as regras de validação e o SQL para ler o custo
por tag, é o [tags.md](tags.md). Em resumo:

| Recurso ou uso | Mecanismo |
|---|---|
| SQL Warehouse, projeto Lakebase, job de auto-config | tags no bundle |
| Catálogo, schema, volume e função Python da instalação | definidos pelo job de auto-config |
| Chamadas ao AI Gateway | `usage_context` em toda chamada (`server/llm.js`, `server/resourceTags.ts`) |
| Instruções do SQL Warehouse | `query_tags` em toda chamada |
| O próprio App | não tem campo `tags`; use uma serverless usage policy ([§8](#8-databricks-app-spaces-beta)) |

Toda instalação carrega a tag embutida `ai_prism_app=<nome do app>`, que não pode ser
sobrescrita, e a chave `application` é reservada. Chaves sugeridas para uma frota (são só
uma convenção; o app aceita qualquer chave válida): `instance` (nome curto da instalação),
`environment` (`dev` ou `prod`), `owner_team` (chargeback).

### 3.3 Inventário

Mantenha, por instalação, a lista de recursos que o bundle e o operador criaram.
Ela é a base do decomissionamento (§7). Itens a registrar além da tabela acima:

- Schemas e volumes criados por fora do bundle (ex.: o catálogo de imagens quando o
  auto-config não tem permissão e um admin o cria à mão).
- Dashboards publicados manualmente, com o ID da versão em produção.
- Conexões MCP e catálogos MCP publicados por admins.

### 3.4 Versões

`GET /api/health` (atrás da mesma autenticação do resto de `/api`) responde
`{ status, db, version, commit, uptime_s }` (`server/routes/health.js`, `server/version.js`):
`version` é a versão do `package.json` gravada no build. Registre também o SHA do commit no
inventário (§3.3) a cada `apps deploy`, porque `version` só muda em um release.

### 3.5 Comparar instalações

Com o SHA registrado, um `git diff <sha-A> <sha-B> -- server-dist client/dist` mostra
se duas instalações estão no mesmo artefato. Artefatos iguais garantem o mesmo código,
não a mesma configuração de bundle.

---

## 4. Guardrails do bundle

Os limites abaixo estão no `databricks.yml`. Eles são o piso de custo e de superfície
de cada instalação. Mudá-los exige revisão.

| Guardrail | Valor | Efeito |
|---|---|---|
| Lakebase autoscaling | 0,5 a 16 CU | Teto de capacidade e custo |
| Lakebase suspensão | `lakebase_suspend_timeout` sem uso (padrão 600 s) | Para de cobrar compute ocioso |
| SQL Warehouse | 2X-Small, `max_num_clusters: 1`, auto-stop 10 min | Teto de custo da UDF e das UC Functions |
| Escopos OBO | `user_api_scopes`, com motivo por escopo | Privilégio mínimo para as APIs usadas |
| Recursos de acesso | `CAN_USE` no warehouse, `CAN_CONNECT_AND_CREATE` no Lakebase | Só o app acessa esses recursos |
| Modo de deploy | `dev` com `mode: development`; `prod` com `mode: production` | Distingue o ambiente de produção |
| Busca na web | Só com `WEB_SEARCH_CONNECTION` configurada | Desligada por padrão |
| Transcrição | `TRANSCRIBE_DISABLED=1` desliga o recurso | Controle de custo e de dados |

**Lacunas de guardrail:**

- Não há limite de gasto por usuário no app (G4 do modelo de ameaças). Use orçamentos
  nativos do workspace.
- O bundle nunca cria uma serverless usage policy (é um objeto de conta, compartilhado entre
  workspaces). Para associar uma existente ao App e ao job de auto-config, passe o id na
  variável `serverless_usage_policy_id` (`deploy.sh --usage-policy-id <id>`; veja
  [tags.md](tags.md#serverless-usage-policy)). Vazia por padrão: nenhuma política associada.
- Não há política de quem pode ser admin além da tabela `app_admins`.

---

## 5. Atribuição de custo

Três fontes, com finalidades diferentes:

| Fonte | O que mede | Granularidade | Limitação |
|---|---|---|---|
| `system.serving.endpoint_usage` filtrada por `usage_context['application']='ai-prism'` | Tokens e chamadas por usuário e endpoint | Usuário × endpoint × dia | A atribuição por time exige as tags de recurso do operador (`usage_context['<key>']`, [tags.md](tags.md)); chamadas feitas antes de as tags serem implantadas carregam só as embutidas |
| `system.billing.usage` × `list_prices` (dashboard de custos) | Custo faturado do endpoint, rateado por tokens do usuário | Endpoint × dia, e usuário por aproximação | Custo rateado é estimativa; o total é real |
| `usage_ledger` (Lakebase, por chamada) | Custo por chamada e por sessão, no taxímetro | Chamada | Fica no banco do app; não aparece em `system.*` |

**Regra para o relatório mensal:** o total vem de `system.billing.usage` (faturado); a
divisão por usuário vem do dashboard de custos e é rotulada como rateio. Não some o
`usage_ledger` ao faturado: são visões diferentes do mesmo gasto.

**Recursos de infraestrutura** (Lakebase, warehouse, job) são faturados à parte e carregam
as tags do operador em `system.billing.usage.custom_tags` (consulta no [tags.md](tags.md));
o App é atribuído pela sua serverless usage policy (`usage_metadata.usage_policy_id`). O
rateio por usuário não se aplica a eles.

---

## 6. Operação em frota

- **Atualização:** a mesma sequência (bundle deploy, apps deploy, auto-config, smoke)
  em cada instalação, com o smoke como barreira. Não atualize todas ao mesmo tempo:
  comece por uma instalação de teste.
- **Divergência de versão:** compare os SHAs do inventário (§3.4). Divergência por tempo
  prolongado é dívida operacional.
- **Incidente:** o responsável da instalação segue o runbook de
  [operations.md](operations.md#6-runbook). Incidentes de segurança seguem o
  [SECURITY.md](SECURITY.md).
- **Mudança de admin:** feita pela UI ou por `POST /api/admins`, sempre por um admin
  existente. Registre a mudança também no inventário. O app grava toda mudança de admin, e a
  concessão do primeiro admin do deploy, na sua própria trilha `admin_audit`, só de inserção (G8,
  fechada no [modelo de ameaças](security-threat-model.md#7-lacunas-declaradas)):
  `server/migrations/0007_settings_audit.up.sql:46` (tabela) e `:103-106` (RLS: só admins leem, sem
  política de UPDATE/DELETE), `server/audit.ts:104` (`recordAdminAction`, na transação da mutação) e
  `:137` (`recordBootstrapAdminSeeds`, chamada em `server/db.ts:89`), lida por admins via
  `GET /api/admin/audit` (`server/db/admin.ts:92`). O ator é um hash (`auditHash`, `server/audit.ts:43`),
  nunca o e-mail; configure `APP_AUDIT_HASH_KEY` para que o hash não se reverta por dicionário. Com a
  chave, o hash de auditoria difere, de propósito, do `user_hash` dos logs; para localizar uma pessoa
  nos dois, veja [security-threat-model.md §6.1](security-threat-model.md#61-correlacionando-a-trilha-de-auditoria-com-os-logs).
  Use a mesma chave em todas as instalações só se precisar comparar trilhas; uma chave diferente por
  instalação limita o que uma chave vazada expõe.

---

## 7. Decomissionamento

Ordem recomendada. Itens marcados com **(irreversível)** não têm desfazer.

1. **Comunique** os usuários e defina a data de corte. Não há exportação em massa das
   conversas no app: quem precisa guardar conteúdo deve fazê-lo antes.
2. **Congele o acesso:** pare o app (`databricks apps stop ai-prism -p <PROFILE>`) e
   confirme que não responde.
3. **Revogue admins:** remova as entradas de `app_admins` (ou o acesso dos grupos
   associados) para que nenhum acesso administrativo sobreviva.
4. **Exporte o que precisa ficar** antes dos passos irreversíveis: ledger de custos
   (`usage_ledger`), dashboards e qualquer artefato que o time queira manter.
5. **Remova o dashboard** do workspace (e o objeto na lixeira, se o nome precisar ser
   reutilizado). A API Lakeview tem só `trash`, sem restauração.
6. **Remova o job de auto-config e o warehouse** (`ai-prism`). Confirme que não há execução
   em andamento.
7. **Apague o projeto Lakebase** `ai-prism`. **(irreversível)** Apaga conversas, artefatos,
   embeddings e o ledger. Confirme a política de backup da plataforma antes.
8. **Apague os recursos de dados:** Volume `ai_prism_images` (com as imagens) e, se
   criados só para esta instalação, o schema e o catálogo `ai_prism_*`. **(irreversível)**
   Confira se o catálogo não é compartilhado com outra instalação.
9. **Apague o app** `ai-prism` e a UDF Python (`ai_prism_python_exec`) do schema.
10. **Confirme a limpeza:** liste os recursos do bundle e verifique que nada sobrou
    (`databricks apps list`, console do Lakebase, warehouses e catálogos).
11. **Revogue credenciais:** tokens e segredos usados no deploy, e o acesso do SP de
    teste, se houver.
12. **Atualize o inventário** e registre a data e o responsável do decomissionamento.
13. **Confira a cobrança:** em `system.billing.usage`, o custo da instalação deve zerar
    após o último dia de uso.

*Atenção:* o passo 7 e o 8 não são reversíveis. Faça-os só depois de confirmar com o
responsável de custo e com o dono dos dados.

---

## 8. Databricks App Spaces (Beta)

Os App Spaces são um recurso do Databricks, em **Beta**, para governar quem constrói apps em
um workspace e sob quais limites. Tudo na primeira lista abaixo vem da documentação oficial:
[App Spaces](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/app-spaces),
[App authorization](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth) e
[Serverless usage policies](https://docs.databricks.com/aws/en/admin/usage/budget-policies).
O comportamento do Beta pode mudar; leia as páginas atuais antes de depender dele.

**O que a documentação diz**

- Um admin do workspace precisa habilitar **Governed agentic app-building** na página de
  Previews, e só um admin do workspace pode criar um App Space.
- Permissões do space: `CAN CREATE APP` (desenvolver apps no space), `CAN MANAGE` (alterar as
  configurações do space) e `CAN READ` (ver o space sem criar apps). O nome do space não pode
  ser alterado depois de criado.
- O admin define quais escopos de autorização do usuário (on-behalf-of) os apps do space podem
  solicitar (um space novo parte do preset "Data + AI"), e pode restringir apps a um papel. As
  restrições de papel usam grupos de conta e exigem RBAC habilitado nos níveis de conta e de
  workspace; um papel não concede permissões novas.
- Os apps em um space rodam sob uma serverless usage policy, cujas tags chegam a
  `system.billing.usage.custom_tags`.
- Cada app do Databricks recebe automaticamente o seu próprio service principal dedicado.

**Como usar com o AI Prism** (recomendação nossa, não regra da plataforma)

| Pergunta | Convenção |
|---|---|
| Quem cria apps? | Conceda `CAN CREATE APP` no space só ao grupo que opera o AI Prism; os demais recebem `CAN READ` ou nada. |
| Quantas instalações por space? | Um AI Prism por space, para que os escopos e a política de gasto do space descrevam exatamente uma instalação. |
| Com qual identidade roda? | O service principal do próprio app (um por app); nunca compartilhe um SP entre instalações. O acesso ao Lakebase, ao Volume e os grants do UC são dados só a esse SP. |
| Quais escopos? | Faça os escopos permitidos do space um superconjunto de `user_api_scopes` em `databricks.yml`, e não mais largo; um escopo que o space não permite não pode ser solicitado pelo app. Confira isso após cada mudança em qualquer das duas listas. |
| Qual política de gasto? | Uma serverless usage policy por instalação ou por responsável de custo, passada ao bundle como `serverless_usage_policy_id` ([tags.md](tags.md#serverless-usage-policy)). Tags: [tags.md](tags.md). |
| O que não foi verificado aqui? | Como um app é colocado em um determinado space pelo `bundle deploy` (a página da documentação não descreve uma etapa de atribuição) e se a lista de escopos do space interage com os escopos que o bundle aplica. Teste os dois em um workspace de não produção antes de depender deles. |

Atualizações desta seção exigem reler as três páginas acima, pois o recurso está em Beta.
