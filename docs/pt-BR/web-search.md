<!-- i18n: source=docs/web-search.md source-hash=685f84ef8a457ccc4e73f85212114a6a4178a1a8 status=current -->
# Busca e leitura da web

[English](../web-search.md) · **Português (Brasil)** · [Español](../es/web-search.md)

O AI Prism oferece duas tools nativas aos modelos:

- `web_search` encontra páginas públicas e devolve título, URL e snippet (ou uma
  resposta sintetizada com as fontes).
- `web_fetch` abre uma URL pública e devolve o conteúdo real em texto legível. É
  o único leitor de páginas: um snippet de busca nunca é tratado como a página.

As duas tools são oferecidas juntas, em qualquer turno, só quando pelo menos um
backend de busca está disponível para o usuário que envia aquele turno. Caso
contrário o modelo não vê nenhuma das duas e a resposta não é ancorada na web,
exatamente como antes (apresentações e documentos passam a sinalizar números
não confirmados como estimativa).

## Como o backend é escolhido

`web_search` percorre uma cadeia ordenada e o primeiro backend que responde
vence:

| Ordem | Backend (valor em `WEB_SEARCH_BACKEND`) | O que é | Identidade |
|---|---|---|---|
| 1 | `managed-mcp` | O MCP gerenciado pela Databricks `system.ai.web_search`, via Unity Gateway | o token do próprio usuário |
| 2 | `external-mcp` | Um servidor MCP que o workspace registrou como MCP Service no Unity Gateway, indicado em `WEB_SEARCH_MCP_SERVICE` | o token do próprio usuário |
| 3 | `brave` | Brave Search API | chave em um secret do Apps |
| 4 | `tavily` | Tavily Search API | chave em um secret do Apps |
| 5 | `searxng` | Uma instância SearXNG hospedada por você | nenhuma |

Com o padrão `WEB_SEARCH_BACKEND=auto`, todo backend configurado é usado nessa
ordem. O MCP gerenciado só é tentado onde está de fato disponível para o
usuário (é um serviço Beta, liberado por preview, que não existe em toda região
ou nuvem). Um deployment que não configura nada, num workspace sem o serviço
gerenciado, se comporta como se a busca na web não existisse.

A disponibilidade é verificada por usuário, porque os dois caminhos MCP rodam
com os grants do próprio usuário no Unity Catalog. Um usuário sem `EXECUTE`
num serviço simplesmente pula esse serviço; os demais não são afetados. A
verificação é uma listagem de tools em cache, feita em segundo plano (quando o
app carrega e de novo quando o resultado em cache expira); um turno de chat
nunca espera por ela.

## Configuração

Escolha uma ou mais opções abaixo. Todas ficam no `app.yaml` (o `config.env`
do bundle não chega ao app em execução). Reimplante depois de mudar.

### Opção 1: o MCP de busca gerenciado (nada a configurar no app)

Onde a sua nuvem e região oferecem, um account admin habilita o preview
*Enhanced Unity Gateway* (account console → Previews). Account users têm
`EXECUTE` em `system.ai.web_search` e `USE CATALOG system` /
`USE SCHEMA system.ai` por padrão. Nada mais é preciso: o `auto` já o inclui.
Ele devolve uma resposta sintetizada com citações; o modelo por trás não é
selecionável e a Databricks não publica preço.

Não está disponível com HIPAA/BAA, para usuários só de consumer access, nem
quando controles de rede desligam o acesso à internet.

### Opção 2: um provedor de busca MCP externo (Firecrawl, You.com, Tavily, Exa…)

Use onde o serviço gerenciado não existe (por exemplo no Azure hoje) ou quando
preferir outro provedor. A chave do provedor fica numa connection do Unity
Catalog, nunca no app.

1. **Registre o servidor** (admin do workspace ou do metastore): Unity Gateway →
   MCPs → *Connect an existing MCP server*. Use o endpoint Streamable HTTP do
   fornecedor e coloque a chave do provedor na connection como bearer token.
   Exemplos:

   | Provedor | Endpoint a registrar | Tool de busca |
   |---|---|---|
   | Firecrawl | `https://mcp.firecrawl.dev/v2/mcp-search` (só busca) | `firecrawl_search` |
   | You.com | `https://api.you.com/mcp` (ou o listing do Marketplace) | `you-search` |
   | Tavily | `https://mcp.tavily.com/mcp/` | `tavily-search` |
   | Exa | `https://mcp.exa.ai/mcp?tools=web_search_exa` | `web_search_exa` |
   | Qualquer outro | um servidor Streamable HTTP de sua confiança | defina `WEB_SEARCH_MCP_TOOL` |

2. **Restrinja o serviço à tool de busca.** Configure a seleção de tools
   (`include_tool_selectors`) para expor só a tool de busca, ou registre o
   endpoint só-de-busca do fornecedor. Assim o grant que os usuários recebem vale
   uma tool de busca e nada mais. Este passo é obrigatório.
3. **Conceda acesso** aos usuários do app: `EXECUTE` no serviço e `USE CATALOG`
   e `USE SCHEMA` no catálogo e schema dele. Usuários não precisam de
   `USE CONNECTION`.
4. **Aponte o app para ele** no `app.yaml`:

   ```yaml
   - name: WEB_SEARCH_MCP_SERVICE
     value: 'my_catalog.my_schema.firecrawl_search'
   # optional, when the tool name is not one of the known ones above
   - name: WEB_SEARCH_MCP_TOOL
     value: 'firecrawl_search'
   ```

Como o app trata esse serviço:

- Chama **uma tool** nele: `WEB_SEARCH_MCP_TOOL`, senão um nome de tool de busca
  conhecido, senão uma tool cujo nome casa com `web_search`/`web-search`. Se
  nenhuma for encontrada, o backend aparece como "tool de busca não
  identificada" e nada é chamado.
- Os argumentos são montados pelo app só a partir da consulta e do limite de
  resultados.
- As descrições e instruções das tools do servidor nunca chegam ao modelo.
- O serviço não aparece no catálogo MCP e os usuários não conseguem conectá-lo
  por conta própria: um serviço com credencial compartilhada continua recusado
  em todo caminho de conexão do usuário. Se um usuário já tem esse serviço (ou
  `system.ai.web_search`) conectado, essa conexão é ignorada nos turnos em que a
  tool nativa é oferecida, para o modelo nunca ver duas tools de busca.
- Um serviço com login por usuário (OAuth U2M) não serve para esta função:
  usuários sem consentimento são tratados como não autorizados.

### Opção 3: uma API de busca com chave (último recurso)

Guarde a chave num secret scope da Databricks, declare-a como recurso `secret`
do app e mapeie no `app.yaml` com `valueFrom` (veja os exemplos comentados em
`databricks.yml` e `app.yaml`):

```yaml
- name: BRAVE_SEARCH_API_KEY
  valueFrom: 'web-search-key'
```

`TAVILY_API_KEY` funciona do mesmo jeito. `SEARXNG_URL` aponta para uma
instância SearXNG hospedada por você com o formato JSON habilitado
(`/search?format=json`); um endereço privado é recusado como qualquer URL
privada. Os caminhos com chave precisam de saída do app para
`api.search.brave.com` ou `api.tavily.com`; os caminhos MCP não precisam de
nenhuma a partir do app (quem faz a chamada é o gateway).

### Todas as configurações

| Variável | Padrão | Significado |
|---|---|---|
| `WEB_SEARCH_DISABLED` | vazio | `1` desliga as duas tools; vence qualquer outra |
| `WEB_SEARCH_BACKEND` | `auto` | `auto`, `off`, um backend, ou uma lista ordenada separada por vírgula como `external-mcp,brave`. Um valor desconhecido desliga a busca (falha fechada) |
| `WEB_SEARCH_MCP_SERVICE` | vazio | MCP Service externo, `<catalogo>.<schema>.<servico>`. O legado `WEB_SEARCH_CONNECTION` é lido como alias quando tem três partes |
| `WEB_SEARCH_MCP_TOOL` | vazio | fixa o nome da tool de busca no serviço externo |
| `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY` | vazio | fallback com chave, de um secret do Apps |
| `WEB_SEARCH_COUNTRY`, `WEB_SEARCH_LANG` | vazio | padrões do Brave |
| `SEARXNG_URL` | vazio | sua instância SearXNG |
| `WEB_SEARCH_PRICE_PER_1K_USD` | vazio | preço por 1.000 buscas para todos os provedores; vale mais que os preços embutidos de Brave/Tavily/SearXNG e menos que um preço definido pelo admin |
| `WEB_SEARCH_TIMEOUT_MS` / `WEB_SEARCH_MCP_TIMEOUT_MS` / `WEB_SEARCH_DEADLINE_MS` | `12000` / `20000` / `30000` | tentativa com chave / tentativa MCP / busca inteira |

A chave geral da organização é a política de tool `web-search` (aba Tools do
admin): desligada, remove as duas tools para todos sem reimplantar.

## Custos

Toda busca respondida grava uma linha no ledger de uso (`kind = web_search`; a
coluna de modelo guarda o provedor: `databricks`, `firecrawl-mcp`, `you-mcp`,
`tavily-mcp`, `exa-mcp`, `brave-mcp`, `mcp`, `brave`, `tavily`, `searxng`).
Tentativas que falham não gravam nada, nem um turno que o usuário cancelou. O
Brave custa USD 5 e o Tavily USD 8 por 1.000 buscas; o SearXNG não custa nada.
Os provedores MCP não têm preço publicado, então as linhas deles aparecem como
"não precificado" até um admin definir um (um override de preço para
`tool:web_search:<provedor>` ou `tool:web_search`, ou
`WEB_SEARCH_PRICE_PER_1K_USD`). O provedor cobra no plano dele (o Firecrawl,
por exemplo, cobra créditos por busca); o gateway também registra cada chamada
MCP em `system.ai_gateway.usage`.

### O tile de custo e o editor de preço

O admin vê quanto a busca na web custa na página Custos (o tile **Busca na web**, abaixo do seletor
de período). Ele lê o razão de uso do próprio app, não as system tables, então funciona sem SQL
warehouse e mostra chamadas e custo do período escolhido: totais, chamadas por dia, a divisão por
provedor e os usuários mais ativos. Os usuários aparecem como um hash com chave (o mesmo da página de
auditoria), nunca como e-mail.

As chamadas sem preço aparecem como **sem preço**, com uma estimativa ao preço em vigor. Sob o tile,
**Preço por 1.000 chamadas** define o preço para todos os provedores (`web_search`) ou para um provedor
visto no período (`web_search:<provedor>`), em USD de 0 a 1000; um campo vazio remove a sobrescrita. O
preço vale para as **próximas** chamadas: o custo de uma linha do razão é fixado quando ela é gravada,
então salvar um preço nunca reescreve o histórico. Cada mudança entra na trilha de auditoria do admin
como `tool_price.set`. O mesmo livro de preços está por trás de
`GET /api/admin/usage/tools?kind=web_search[&from=AAAA-MM-DD&to=AAAA-MM-DD]` (só agregados) e de
`PUT /api/admin/tool-prices/:key` (corpo `{ "per1kUsd": 5 }`, ou `null` para limpar). Outra instância em
execução assume o novo preço quando o cache do catálogo de modelos recarrega (cerca de 30 s).

## Status para o admin

`GET /api/admin/web-search/status` devolve a cadeia resolvida, uma linha por
backend com o estado para o admin que chama (`up`, `down` com um código, ou
`unknown`), o serviço e a tool nas linhas MCP, se há chave nas linhas com chave
(nunca o valor) e os resultados das últimas 24 horas.
`POST /api/admin/web-search/verify` recebe `{ "entry": <índice da linha>, "kind": "<backend>" }`
e faz UMA busca real nessa entrada da cadeia com uma consulta fixa, como o
admin, e devolve só contagens (no máximo uma vez a cada 10 s por admin e por
entrada; entrada inválida ou desatualizada é 400, sem chamar o provedor). O card
do admin em Configurações → Ferramentas mostra as linhas com um botão Verificar
em cada uma.

| Código | Significado |
|---|---|
| `forbidden` | sem permissão ou serviço inexistente (o gateway não distingue); também chave do provedor inválida na connection |
| `unconfigured` | nenhuma tool de busca identificada, ou a seleção de tools a exclui |
| `quota` | limite de taxa ou cota do provedor (HTTP 429) |
| `timeout` | a tentativa excedeu o limite de tempo |
| `unavailable` | qualquer outra falha |
| `bad_response` | o provedor respondeu num formato inesperado |

## Privacidade e segurança

- Toda consulta sai do workspace para o provedor de busca. A descrição da tool
  instrui o modelo a nunca colocar dados internos, nomes de clientes ou conteúdo
  de anexos numa consulta; o risco residual permanece. Uma política de Sensitive
  Data Detection do gateway (Beta) pode ser anexada ao MCP Service.
- Resultados de busca não são confiáveis. O resultado da tool vem dentro de um
  envelope fixo de "conteúdo externo, não confiável", e o texto dos resultados
  não consegue fechá-lo.
- Os logs têm uma linha por tentativa (backend, provedor, status, código,
  duração), nunca a consulta, um resultado ou o texto de erro do provedor.
- O serviço gerenciado não está disponível com HIPAA/BAA; nos outros provedores,
  é você quem escolhe e contrata o provedor e aceita os termos dele.

## Leitura de páginas (`web_fetch`)

O leitor aceita só HTTP/HTTPS, resolve e fixa o endereço IP antes de conectar,
recusa redes privadas, loopback e link-local, revalida cada redirect e recusa
redirect entre hosts quando a requisição carrega credenciais. Cada página tem
timeout, limite de redirects, limite de download e limite do texto devolvido ao
modelo. HTML, texto e JSON são lidos; PDFs, páginas atrás de login ou CAPTCHA e
sites que só renderizam com JavaScript devolvem um erro explícito.

## Como desligar

`WEB_SEARCH_DISABLED=1` no `app.yaml` e reimplante, ou desligue a política de
tool `web-search` na aba do admin (sem reimplantar).
