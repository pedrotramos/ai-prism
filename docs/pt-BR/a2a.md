<!-- i18n: source=docs/a2a.md source-hash=5dfc61f01a3c56f3c6aba10c55dfec98805dd59a status=machine -->
# Agentes A2A no AI Prism

[English](../a2a.md) · **Português (Brasil)** · [Español](../es/a2a.md)

> Esta tradução foi feita com apoio de IA e aguarda revisão nativa. Em caso de dúvida, a [versão em inglês](../a2a.md) é a referência.

O AI Prism chama **agentes remotos pelo protocolo A2A** (Agent2Agent, versão 1.0) como tools no
chat. Um admin registra o agente uma vez; a partir daí o modelo pode entregar uma tarefa a ele,
acompanhar o progresso em streaming e usar a resposta, e toda chamada roda com **a credencial do
próprio usuário logado**, nunca com o service principal do app.

Esta página explica o que o recurso faz, como um admin o liga, como os usuários entram nos agentes,
as regras de segurança e como testar com um agente echo pequeno.

---

## O que você ganha

- **Descoberta pelo card.** Você informa ao AI Prism a URL do card do agente (ou o nome de um
  Databricks App). Ele lê o Agent Card (`/.well-known/agent-card.json`), valida e mostra nome,
  descrição, skills e o login que o agente exige.
- **Envio de mensagem e streaming.** A chamada usa `SendMessage`, ou `SendStreamingMessage` quando o
  card diz que o agente faz streaming. As atualizações de status e os artefatos da tarefa voltam ao
  chat como resultado da tool.
- **Agentes como tools do chat.** Cada agente habilitado no catálogo é oferecido ao modelo como uma
  tool chamada `a2a__<slug>`. Um agente que o admin desliga some da lista de tools para todos.
- **Três formas de login**, escolhidas por agente no registro (veja [Estratégias de autenticação](#estratégias-de-autenticação)).
- **Um cartão de autorização no chat.** Quando o agente precisa de um login que o usuário ainda não
  fez, o turno para com o cartão *Autorização necessária*. O usuário autoriza numa janela pop-up e a
  resposta é refeita. O mesmo cartão serve para um serviço MCP que não está conectado para o usuário.
- **Uma página de conexões por usuário.** *Configurações → Conexões MCP* tem uma seção *Agentes A2A*
  abaixo das conexões MCP: conecte ou desconecte cada provedor de login e verifique cada agente com a
  sua conta.

---

## Estratégias de autenticação

| Estratégia | Quem o agente enxerga | Para onde a credencial pode ir | Agente típico |
|---|---|---|---|
| `databricks-obo` | O usuário logado, pelo token Databricks dele (on-behalf-of) | Só este workspace: o host, os Databricks Apps (`*.databricksapps.com` **deste** workspace) e os hosts que o admin marcou com `databricks:` em `A2A_ALLOWED_HOSTS` | Outro Databricks App |
| `oauth2-user` | A conta do usuário num provedor de identidade externo (qualquer OIDC ou OAuth 2.0), por authorization code + PKCE | Só os hosts que casam com os `hostPatterns` desse provedor | Um agente atrás do IdP da empresa ou um SaaS |
| `none` | Ninguém: nenhuma credencial é enviada | Só a origem do próprio agente, e só para um host que o admin liberou com uma entrada simples em `A2A_ALLOWED_HOSTS` | Um agente público |

O AI Prism escolhe a estratégia a partir do card e da lista de hosts quando o admin registra o
agente, e a deriva de novo do card atual antes de cada chamada. Um card que pede um provedor de
identidade que nenhum provedor configurado cobre é recusado: **nunca recorre ao token Databricks**.

### Databricks Apps (OBO)

Os escopos `user_authorization` do app incluem `apps` (`app.yaml`, e `databricks.yml` no deploy do
bundle). Com ele, o token do usuário chama outro Databricks App do mesmo workspace e esse App enxerga
o usuário real. Apague a linha `apps` para desligar o app-to-app. O App de destino precisa deixar esse
usuário entrar (a permissão `CAN_USE` dele); uma recusa aparece como *Sem acesso a este agente*.

A exceção `*.databricksapps.com` só vale quando o AI Prism conhece o id do próprio workspace (o
runtime de Apps define `DATABRICKS_WORKSPACE_ID`, ou o id é lido de `DATABRICKS_APP_URL`). Um App de
outro workspace nunca recebe o token do usuário por suposição.

### Provedores externos (OAuth 2.0 authorization code + PKCE)

O AI Prism executa o login, numa janela pop-up, com PKCE (S256) e um `state` de uso único. Depois da
troca ele confere a identidade (o ID token é verificado com as chaves do provedor e, por padrão, o
e-mail do provedor precisa ser o do usuário) e guarda os tokens **cifrados em repouso** (AES-256-GCM;
o dono da linha e o provedor entram como dado autenticado, então uma linha copiada para outro usuário
ou provedor não decifra). O navegador nunca recebe um token: a página do pop-up só informa um código
de resultado fixo.

---

## Ligue (admin)

1. **Libere o destino.** `A2A_ALLOWED_HOSTS` é uma lista separada por vírgulas de padrões
   `host[:porta][/caminho]` (um `*.` no início casa com um ou mais rótulos):

   ```yaml
   env:
     # entradas `databricks:` podem receber o token Databricks do usuário (OBO).
     # Entradas simples são agentes públicos (nenhuma credencial é enviada).
     - name: A2A_ALLOWED_HOSTS
       value: 'databricks:agents.example-corp.com,public-agent.example.org'
   ```

   Hosts deste workspace e os Databricks Apps dele não precisam de entrada. Sem uma regra que case, o
   host é recusado, seja o que o card disser.

2. **Para `oauth2-user`, configure um provedor** (um array JSON em `A2A_OAUTH_PROVIDERS`), a chave de
   cifragem e a base do redirect:

   ```yaml
   - name: A2A_OAUTH_PROVIDERS
     value: >-
       [{"id":"corp-idp","name":"Corp IdP","issuer":"https://idp.example-corp.com",
         "clientId":"ai-prism","clientSecretEnv":"CORP_IDP_SECRET",
         "scopes":["openid","email","agents.invoke"],
         "hostPatterns":["agents.example-corp.com"]}]
   - name: CORP_IDP_SECRET
     valueFrom: 'corp-idp-secret'          # um secret resource, nunca um literal
   - name: A2A_TOKEN_ENC_KEY
     valueFrom: 'a2a-token-key'            # 32 bytes aleatórios em base64 ou 64 caracteres hex
   - name: A2A_OAUTH_REDIRECT_BASE         # só quando difere de DATABRICKS_APP_URL
     value: 'https://my-app.example.com'
   ```

   Registre `<URL do app>/api/a2a/oauth/<id do provedor>/callback` como redirect URI no provedor
   (*Configurações → Ferramentas → Agentes A2A*, só para admin, mostra o valor exato por provedor).
   Campos do provedor:

   | Campo | Significado |
   |---|---|
   | `id` | `[a-z0-9_-]`, até 32 caracteres. Faz parte da URL de callback |
   | `issuer` | Issuer OIDC; os endpoints vêm do documento de discovery. Ou informe `authorizationEndpoint` + `tokenEndpoint` (e, se quiser, `userinfoEndpoint`, `jwksUri`, `revocationEndpoint`) |
   | `clientId`, `clientSecretEnv` | O client OAuth. O segredo é lido da variável de ambiente **nomeada** aqui; omita-o num client público (`tokenEndpointAuthMethod: none`) |
   | `scopes` | Padrão `openid email` em OIDC |
   | `hostPatterns` | Para onde o token pode ser enviado. Cada entrada é um padrão, ou `{ "pattern": "...", "send": "access-token" \| "id-token" }` |
   | `requireEmailMatch` | Padrão `true`: o e-mail verificado da conta do provedor precisa ser igual ao do usuário |
   | `idTokenHeader` | Nome de cabeçalho extra, opcional. Um padrão com `send: "id-token"` passa a receber o ID token ali também (para um gateway que o confere antes de repassar) |
   | `authParams` | Parâmetros extras da requisição de autorização (nunca `state`, `code_challenge` e os demais do protocolo) |

   Sem `A2A_TOKEN_ENC_KEY` a estratégia fica desligada e o painel do admin avisa.

3. **Registre o agente.** *Configurações → Ferramentas → Agentes A2A* (admin): cole a URL do card, ou
   o nome de um Databricks App deste workspace, e clique em *Registrar*. O AI Prism lê o card sem
   nenhuma credencial, deriva a estratégia e lista o agente com o status. *Verificar de novo* relê o
   card; a chave oferece ou esconde o agente; *Remover* o tira do catálogo. O login pertence ao
   provedor, não ao agente, então remover um agente mantém as conexões dos usuários.

Outros limites (todos opcionais): `A2A_REQUEST_TIMEOUT_MS`, `A2A_STREAM_TIMEOUT_MS`,
`A2A_MAX_RESPONSE_BYTES` e `A2A_ALLOW_INSECURE_LOCAL=1` (http para loopback, **só para
desenvolvimento local**).

---

## Para os usuários

- Peça no chat algo que um agente faz. Se o agente precisa de um login, aparece o cartão
  *Autorização necessária*. Clique em *Autorizar com …*, conclua o pop-up e a resposta é refeita.
- *Configurações → Conexões MCP → Agentes A2A* lista os logins e os agentes. *Verificar* testa um
  agente com a sua própria conta; *Desconectar* pede ao provedor que revogue a concessão e apaga os
  tokens cifrados. Se o provedor não confirmar a revogação, a conexão é mantida e você pode usar
  *Remover aqui mesmo assim*.

---

## Regras de segurança

- **Nunca a identidade do app.** Toda estratégia usa a credencial do usuário final para o destino.
- **Uma audiência por credencial.** Uma credencial só vai para os hosts que a estratégia permite
  (tabela acima); ela é anexada no transporte e nunca é copiada para o contexto do modelo, os logs
  ou o navegador.
- **Saída protegida** (`server/a2aGuard.ts`, compartilhado com as regras anti-SSRF do `web_fetch`):
  só https (http para loopback apenas com `A2A_ALLOW_INSECURE_LOCAL=1`), o destino precisa cumprir a
  lista da estratégia, todo endereço resolvido é conferido no momento da conexão (loopback,
  link-local, metadata, ULA e outras faixas reservadas são bloqueados; faixas privadas só para um
  host comprovado do workspace), redirects nunca são seguidos, as requisições têm timeout, os corpos
  têm limite e os cabeçalhos enviados são reconstruídos a partir de uma lista curta.
- **Tokens em repouso.** `a2a_oauth_tokens` é só do dono sob row-level security (nem um admin lê) e
  as colunas são cifradas com AES-256-GCM. Perder a chave significa que os usuários entram de novo.
- **Saída não confiável.** O que um agente devolve é dado, não instrução: é envolvido e truncado
  como outros resultados de tool, e o texto do card (nome, descrição, skills) é saneado e citado
  como metadado antes de chegar ao prompt.
- **Auditoria.** Registrar, habilitar e remover um agente ficam na trilha de auditoria de admin
  (`a2a.agent.add`, `a2a.agent.update`, `a2a.agent.remove`).

Veja o [modelo de ameaças](security-threat-model.md) (TB6) e o [FAQ de segurança](security-faq.md).

---

## Teste com o agente echo

`server/testing/a2aEchoAgent.ts` é um agente A2A 1.0 minúsculo usado pelos testes. Ele repete a sua
mensagem e tem palavras de gatilho: `input needed` (a tarefa pede mais informação), `fail` (a tarefa
falha) e `slow` (fica trabalhando uns 20 s, a menos que seja cancelada).

Localmente, com o AI Prism em modo dev:

```bash
A2A_ALLOW_INSECURE_LOCAL=1 A2A_ALLOWED_HOSTS=127.0.0.1:4590 \
  node -e "import('./server/testing/a2aEchoAgent.ts').then(m => m.startEchoAgent({ port: 4590, streaming: true }))"
```

depois registre `http://127.0.0.1:4590/.well-known/agent-card.json` em *Configurações → Ferramentas →
Agentes A2A* e peça ao modelo para *pedir ao agente echo que diga olá*.

Como Databricks App (para ver o caminho OBO de ponta a ponta), o mesmo agente está empacotado em
`examples/a2a-echo/`. Faça o deploy como um App próprio, dê `CAN_USE` ao usuário e registre o nome do
App. Apague o App quando terminar.

---

## Referência

| Configuração | Onde | Para quê |
|---|---|---|
| `apps` | `user_authorization` em `app.yaml`, `databricks.yml` | Deixa o token do usuário chamar outro Databricks App (OBO) |
| `A2A_ALLOWED_HOSTS` | env | prefixo `databricks:` = pode receber o token Databricks; entrada simples = agente público |
| `A2A_OAUTH_PROVIDERS` | env (JSON) | Provedores de login externos |
| `A2A_TOKEN_ENC_KEY` | env (secret) | Chave de 32 bytes (base64 ou hex) que sela os tokens guardados |
| `A2A_OAUTH_REDIRECT_BASE` | env | URL pública base do callback; padrão `DATABRICKS_APP_URL` |
| `A2A_REQUEST_TIMEOUT_MS`, `A2A_STREAM_TIMEOUT_MS`, `A2A_MAX_RESPONSE_BYTES` | env | Limites de saída |
| `A2A_ALLOW_INSECURE_LOCAL` | env | `1` permite http para loopback (só desenvolvimento) |

| Rota | Quem | Para quê |
|---|---|---|
| `GET /api/a2a/agents` | qualquer usuário | Catálogo com o status deste usuário por agente |
| `POST /api/a2a/agents`, `POST /api/a2a/agents/:id/verify`, `PUT /api/a2a/agents/:id/enabled`, `DELETE /api/a2a/agents/:id` | admin | Registrar, reler o card, oferecer ou esconder, remover |
| `POST /api/a2a/agents/:id/check` | qualquer usuário | Testar um agente com a credencial do próprio usuário |
| `GET /api/a2a/providers`, `GET /api/admin/a2a/providers` | usuário, admin | Provedores (a visão de admin soma o redirect URI e os erros de configuração) |
| `GET /api/a2a/oauth/:provider/start`, `GET /api/a2a/oauth/:provider/callback`, `DELETE /api/a2a/oauth/:provider` | usuário | Login em pop-up, callback, desconectar |
