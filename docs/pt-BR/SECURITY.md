<!-- i18n: source=SECURITY.md source-hash=8566efd2881d51164ce44ba63763866ebf867bb8 status=current -->
# Política de Segurança

[English](../../SECURITY.md) · **Português (Brasil)**

O AI Prism é um acelerador de solução open-source que você deploya no **seu próprio**
workspace Databricks. Não é um produto oficial da Databricks e não possui SLA. Ainda
assim, levamos vulnerabilidades a sério — este documento explica como reportá-las.

## Reportando uma vulnerabilidade

**Não abra uma issue pública** para relatar uma vulnerabilidade de segurança.

Em vez disso, use o canal privado do GitHub:

1. Acesse a aba **Security** do repositório.
2. Clique em **Report a vulnerability** (GitHub Security Advisories).

Se preferir, abra uma issue mínima **sem detalhes técnicos** pedindo um canal privado
de contato, e a resposta virá por lá.

Inclua no relatório, sempre que possível:

- Uma descrição da vulnerabilidade e do impacto potencial.
- Passos para reproduzir (proof of concept).
- Versões/ambiente afetados (cloud, versão do Databricks CLI, commit).
- Qualquer mitigação que você já tenha identificado.

Faremos o possível para confirmar o recebimento em poucos dias úteis e manter você
informado sobre o progresso até a resolução.

## Escopo

Como cada instalação roda no workspace de quem deploya, tenha em mente o modelo de
confiança do projeto:

- **Isolamento entre usuários é feito no nível da aplicação** (cláusulas `WHERE user_email`),
  sobre uma identidade fornecida pelo proxy da Databricks App. Relatos sobre furos nesse
  isolamento (um usuário acessando dados de outro) são especialmente bem-vindos.
- Autenticação usa **OBO (on-behalf-of) do usuário** para chamadas de API e o **service
  principal do app** para armazenamento próprio (Lakebase, Volume de imagens).
- Segredos (tokens do workspace, credenciais do Lakebase) **nunca** devem ser commitados.
  Veja o [`.env.example`](../../.env.example) e o [`.gitignore`](../../.gitignore) — `.env` é ignorado.

## Identidade da requisição

Quem é o usuário vem só do proxy do Databricks Apps (`server/requestIdentity.js`):

- No runtime de Apps (presença de `DATABRICKS_APP_NAME`, `DATABRICKS_APP_PORT` ou
  `DATABRICKS_APP_URL`), a requisição precisa do header `x-forwarded-email` e do
  `x-forwarded-access-token`. Faltando qualquer um, a resposta é **401**. Nenhum e-mail
  ou token vem do ambiente nesse caso.
- Fora do runtime, o ambiente só entra com `LOCAL_DEV_MODE=1` (o `.env.local` do
  `npm run dev:local`) ou `LOCAL_DEV_IDENTITY=1`. `NODE_ENV` não conta: o npm o define
  como `production` nos scripts do repo.

## Isolamento entre usuários

Todas as conexões Postgres usam a mesma identidade (o service principal do app, ou o
usuário local em dev). Por isso, cada leitura **e cada gravação** precisa filtrar pelo
dono no próprio SQL: `chat_sessions.user_email` e, para o que pertence a uma sessão
(mensagens, tool calls, embeddings, artefatos, conversa Genie), um `EXISTS` sobre a
sessão do chamador. Um id numérico enumerável (BIGSERIAL) não pode ser suficiente.

O que foi reforçado nesta versão:

- **Gravações por id** que antes confiavam numa checagem anterior agora re-checam o dono
  na mesma instrução (`server/ownerScopedWrites.js`): reativação de variantes (o
  `variant_group` vem do cliente), embeddings de mensagem, chamadas de tool, conversa
  Genie (leitura e escrita), embedding de skill e a criação de deck, planilha,
  documento e imagem (sessão alheia dá 404).
- **Testes de dois usuários** em `server/isolation.test.js`, contra as funções reais de
  `db.js`: sessões, mensagens, variantes, tool calls, embeddings e busca semântica,
  artefatos, conexões MCP, skills, Genie e custos. A suíte roda com
  `node --test server/isolation.test.js` contra o Postgres do `npm run local:up` e é
  pulada sem ele. Ela falha no código anterior a estas mudanças (variantes, tool calls,
  embeddings, artefatos, skills e Genie).
- **Escritas que dependem da rota** (sem re-checagem no SQL): `upsertSkill`,
  `deleteSkill`, `updateDeckTemplate`, `deleteDeckTemplate` e `setDeckTemplateScope`
  recebem um flag de admin do chamador e são protegidas pelas rotas
  (`requireAdmin` / `isAdmin`). `getUsageStats` (auditoria de custos de todos os
  usuários) não filtra por dono por desenho: só pode ser exposta atrás de `requireAdmin`.
  Nenhuma rota a usa hoje.

## Conteúdo de terceiros no prompt

Texto que o app não escreve e que vai para o modelo (descrições, instruções e schemas de
tools MCP, títulos e descrições de sala Genie, comentários de funções UC, títulos de
documento) passa por `server/toolMetadata.js`: imperativos ("ignore as instruções"),
rótulos de papel ("system:"), HTML e links são neutralizados, e o texto é limitado em
tamanho. Essa é uma defesa parcial contra injeção de prompt, não uma garantia: o modelo
ainda pode ser influenciado por texto que não casa com os padrões. Por isso o dado de
ferramenta não deve ser tratado como instrução confiável.

Documentos Markdown são gravados sem HTML cru e sem links com esquema perigoso
(`shared/markdownSafety.js`): o editor WYSIWYG renderiza com `innerHTML`, então isso
impede que um membro de projeto execute código no editor de outro.

Quando o app busca uma URL escolhida pelo modelo (ferramenta de página web), a conexão
só segue para endereços públicos: loopback, redes privadas, CGNAT, link-local (incluindo o
endpoint de metadados de nuvem), ULA e reservados ficam bloqueados, em cada salto de
redirecionamento. A mesma regra está em `server/a2aGuard.js`, que será usado pelo A2A.

## TLS para o Postgres (Lakebase)

Por padrão a conexão ao Postgres é **criptografada, mas a cadeia do certificado não é
verificada** (`ssl: { rejectUnauthorized: false }` em `server/db.js`, função
`pgSslOptions`). Essa é a escolha histórica do projeto, e ela tem um custo que você deve
conhecer:

- **Por que existe**: o código não registra a justificativa original. A razão provável é
  operacional: o app não empacota a CA do Lakebase, então a validação com o trust store
  padrão do Node falharia sem configuração extra. Os knobs abaixo tornam a CA configurável
  sem mudar o padrão.
- **Modelo de ameaça**: a conexão sai do container do app para o endpoint do Lakebase
  dentro da rede do workspace. Sem verificação, um atacante capaz de interceptar esse
  caminho poderia se passar pelo endpoint e receber o token do service principal ou a
  credencial do usuário (que é o próprio token OBO, usado como senha). O risco é menor que
  em uma rede pública, mas não é zero.
- **Como fechar**: forneça a CA e a verificação é ligada automaticamente.

| Variável | Efeito |
|---|---|
| (nenhuma) | Criptografado, cadeia não verificada (padrão, sem mudança) |
| `PG_SSL_CA` | PEM inline ou caminho de arquivo com a CA. Liga a verificação |
| `PG_SSL_REJECT_UNAUTHORIZED=1` | Verifica a cadeia (com ou sem `PG_SSL_CA`; sem CA usa o trust store do Node) |
| `PG_SSL_REJECT_UNAUTHORIZED=0` | Não verifica, mesmo com `PG_SSL_CA` (para diagnóstico) |
| `PGSSLMODE=disable` | Sem TLS (só para banco local) |

Com `PG_SSL_CA` a cadeia é verificada por padrão, porque uma CA fixada que não é
verificada não protege nada. Use a CA que o endpoint do seu Lakebase apresenta (ela está
na documentação do Lakebase do seu workspace).

## Fora de escopo

- Vulnerabilidades na plataforma Databricks em si (reporte à Databricks).
- Configurações inseguras feitas por quem deploya (ex.: expor segredos, conceder
  permissões amplas demais no workspace).

## Boas práticas para quem deploya

- Rode sempre a versão mais recente do `main`.
- Não hardcode hosts, tokens ou credenciais em `app.yaml` / `databricks.yml` — o modelo
  cloud-agnóstico injeta tudo em runtime (veja o README).
- Restrinja o acesso à App e ao workspace pelos ACLs da Databricks.
