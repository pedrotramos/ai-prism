<!-- i18n: source=docs/mcp-apps.md source-hash=5187fdd2bfb8e2a1de3a91ae59d5d65bd0a54021 status=current -->
# MCP Apps (apps interativos no chat)

[English](../mcp-apps.md) · **Português (Brasil)** · [Español](../es/mcp-apps.md)

Uma tool MCP pode trazer a própria interface. Quando uma tool que o modelo chamou declara um recurso de interface
(`_meta.ui.resourceUri`, a extensão MCP Apps, SEP-1865), o AI Prism mostra um espaço reservado sob a resposta. Abri-lo
carrega a **View** da própria tool (um pequeno app em HTML) em um quadro isolado, ao lado da conversa.

A funcionalidade vem **desligada**. Esta página explica o que uma View pode e não pode fazer, porque é isso que o
administrador decide ao ligá-la.

## Como ligar

1. Um administrador liga **MCP Apps** em Configurações → Tools (a configuração `mcp_apps_enabled`, auditada como
   `mcp_apps.settings`).
2. Para mantê-la desligada de vez, o operador define `MCP_APPS_DISABLED=1` no ambiente do app. Essa chave vale mais que a configuração.

Enquanto está desligada: o app não anuncia a capacidade aos servidores MCP, nada é capturado, as rotas respondem
`404 mcp_apps_disabled` e nenhum espaço reservado aparece. A reversão é o caminho inverso: desligar a configuração,
depois definir `MCP_APPS_DISABLED=1` e, se preciso, publicar a versão anterior (a coluna fica; a migração de descida só a remove).

## O que acontece

1. Com a funcionalidade ligada, o app diz a cada serviço MCP a que se conecta que sabe mostrar recursos de interface
   (`extensions["io.modelcontextprotocol/ui"].mimeTypes = ["text/html;profile=mcp-app"]`).
2. Depois que o modelo chama uma tool que declara um recurso `ui://`, o app lê esse recurso uma vez, com a mesma URL e
   o mesmo token do usuário, e o guarda junto com a chamada. Só o **tipo MIME `text/html;profile=mcp-app`** é aceito, até
   **1 MiB**, no máximo **4 apps por resposta**, e nunca em uma execução sem supervisão (um agente agendado).
3. Se a leitura falhar (tipo errado, grande demais, lenta, inexistente), a resposta mantém o resultado simples da tool e o
   código do motivo é registrado no log. Nada é guardado.
4. O chat mostra **Abrir app · serviço** com os domínios que o app pode contatar. Enquanto a resposta ainda está sendo
   gerada, o botão fica desativado ("Disponível quando a resposta terminar").
5. Abrir carrega a View. No máximo **3 Views** ficam ativas em uma página.

Uma tool cuja `visibility` não inclui `model` (uma tool **só para o app**) nunca é oferecida ao modelo.

## O que uma View pode e não pode fazer

| | |
|---|---|
| Roda em | um `<iframe sandbox="allow-scripts allow-forms">`: uma **origem opaca**, nunca `allow-same-origin` |
| Servida por | `GET /api/mcp-apps/view/:toolCallId`, só para um iframe (`Sec-Fetch-Dest: iframe`, senão 400), com uma CSP **própria** no lugar da do app |
| Alcança | só as origens que o servidor declarou (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`), depois de filtradas |
| Não alcança | a página ou o DOM deste app, seus cookies, o armazenamento ou a API (`/api/...`), o host do workspace, qualquer host Databricks |
| Pode pedir ao host | chamar uma tool do **mesmo serviço** (o usuário confirma, com os argumentos completos), colocar texto no compositor (nunca enviado), abrir um link https (o usuário confirma), redimensionar (80 a 640 px) |
| Não pode | tela cheia, popups, navegar a página, usar câmera, microfone ou localização, ler recursos, pedir amostragem, baixar arquivos |

A CSP de uma View começa com `sandbox allow-scripts allow-forms; default-src 'none'`, nunca contém `'self'` (exceto em
`frame-ancestors`, para que este app possa enquadrá-la) nem `'unsafe-eval'`. As listas declaradas são filtradas: só
`https://host[:porta]` e `https://*.host`, no máximo 32 por diretiva, e a política resultante tem no máximo 4096 caracteres (uma maior é recusada: o App não é capturado, código `csp_too_long`; um registro guardado acima do limite não é servido); o host deste app, o host do
workspace, qualquer host `databricksapps.com` ou Databricks, IPs literais, outros esquemas, aspas, ponto e vírgula e caminhos
são descartados.

### As chamadas de tool de uma View

Uma View pode chamar uma tool por `POST /api/mcp-apps/:toolCallId/tools/call`. A chamada passa pelas mesmas regras de uma
chamada do modelo:

- o token de **quem está pedindo** (um membro do projeto que abre o App de outra pessoa roda com a própria identidade);
- a classe de credencial do serviço (serviços `shared` e não verificados são recusados);
- a política de tools da organização e o catálogo MCP (um serviço oculto ou um grupo desativado é recusado);
- só uma tool que o servidor marcou como chamável por um app, no serviço de onde veio o App (senão 403 com um código);
- tempo limite de 20 s, resultado de até 1 MiB, 60 chamadas por minuto por usuário;
- uma caixa de confirmação no app (não no quadro) com o serviço, a tool e os **argumentos completos**; mais de 16 KiB de
  argumentos é recusado, nunca truncado.

A chamada não é guardada. Só códigos são registrados no log.

## Quem pode abrir um App

O dono do chat e, em um chat de projeto, todos os membros do projeto (a mesma regra de ler o chat). Qualquer outra pessoa
recebe `404`, idêntico ao de um id que não existe. O HTML guardado é uma foto do que foi mostrado na hora da chamada; ele é
apagado junto com o chat (e pela retenção). A resposta de sessões nunca carrega o HTML.

## Limites

| Limite | Valor |
|---|---|
| Tamanho do recurso | 1 MiB (o banco também confere 1.400.000 bytes) |
| Apps por resposta | 4 |
| Views ativas por página | 3 |
| Fontes por diretiva da CSP | 32; a política emitida, no máximo 4096 caracteres (maior: recusada, nunca encurtada) |
| Argumentos da chamada de tool de uma View | 16 KiB no app, 64 KiB no servidor |
| Tempo limite / resultado / taxa da chamada de tool | 20 s / 1 MiB / 60 por minuto por usuário |
| Altura do quadro | 80 a 640 px |

## Notas de operação

- A migração `0016_tool_call_ui_resource` adiciona `chat_tool_calls.ui_resource` (jsonb, nulo em toda chamada anterior). A
  descida remove a coluna e os Apps já mostrados não podem mais ser reabertos.
- O cliente usa `@modelcontextprotocol/ext-apps` **1.7.5**, fixado exatamente (ADR-0019). Ele só é carregado quando uma View
  abre e nunca entra no bundle do servidor.
- Uma View não pode usar cookies nem armazenamento (a origem é opaca); uma View bem-comportada verifica isso.
- Ainda falta provar em um deploy se o Unity AI Gateway repassa a capacidade `extensions`, o `_meta` das tools e o
  `resources/read`, e se o proxy do Apps deixa os cabeçalhos da View intactos (abaixo). Se o gateway não repassar, a
  funcionalidade fica desligada e nada mais muda.

## Verificação real pendente (G-live)

Ainda não executada; é um deploy e precisa de autorização:

1. Registrar um servidor MCP App de teste como serviço MCP do Unity Catalog.
2. Registrar se o Unity AI Gateway repassa a capacidade `extensions`, o `_meta` das tools e o `resources/read`.
3. Registrar que o navegador recebe a CSP e o `X-Frame-Options` deste app para a View sem alteração pelo proxy do Apps.
4. Se o gateway não repassar, a funcionalidade é entregue desligada, com a constatação documentada.
