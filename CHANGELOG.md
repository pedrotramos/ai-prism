# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o projeto adota o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

<!-- Adicione aqui as mudanças ainda não lançadas, em Added / Changed / Fixed / Removed. -->

### Added

- **Edição de slides mais "Figma-like" (parte 1)**: melhorias na edição manual
  do deck.
  - **Seleção sincroniza com a árvore de elementos**: selecionar um elemento no
    canvas agora expande a árvore até ele e rola o item para a viewport (a
    seleção nas duas direções já existia; faltava o auto-scroll).
  - **Nudge com as setas do teclado**: mover elementos de posição livre
    (absolutos) com ←↑→↓ (1px; 10px com Shift).
  - **Marquee select**: arrastar um retângulo numa área vazia do slide seleciona
    vários elementos de uma vez (Shift, opcional, soma à seleção atual em vez de
    substituí-la).
- **Reordenar/reparentar elementos arrastando na árvore**: a árvore de elementos
  do editor agora aceita drag-and-drop — arraste uma camada para soltá-la ANTES
  ou DEPOIS de outra (linha-guia) ou DENTRO dela (realce), reordenando ou
  mudando o pai. Um nó não pode ser solto dentro da própria subárvore. O
  movimento é aplicado no DOM (a fonte de verdade) e entra no histórico de
  undo/redo como qualquer outra edição.
- **Guias de alinhamento com snap + alinhar/distribuir**: ao arrastar um elemento
  de posição livre (absoluto), linhas-guia aparecem quando suas bordas ou centro
  se alinham a outro elemento ou ao slide, com snap magnético (segure Alt para
  posicionamento fino sem snap). Com vários elementos absolutos selecionados, o
  painel ganha **alinhar** (esquerda/centro/direita, topo/meio/base) e
  **distribuir** (horizontal/vertical, gaps iguais mantendo os extremos). Só
  afeta elementos de posição livre — mover um elemento no fluxo por px brigaria
  com o layout.
- **Imagens no prompt de edição por IA (deck e planilha)**: os prompts de tweak
  eram texto puro; agora aceitam imagens por colar (Cmd/Ctrl+V) ou anexar, com
  thumbnails removíveis antes de enviar. Cap de 4 imagens (~6MB cada).
  - No **deck**, cada anexo tem duplo papel decidido pelo MODELO: se é um ATIVO
    a usar (um logo, uma foto), ele o insere no slide como `<img>` real —
    posicionando/dimensionando no layout — e o arquivo original é injetado pelo
    servidor (SVG entra e sai VETOR, sem rasterizar nem deformar); se é só
    REFERÊNCIA visual (paleta, estilo), ele usa como guia sem inserir. Sem regra
    rígida — a inspiração não é despejada no slide.
  - O que o modelo VÊ é sempre uma cópia raster (a API de visão do gateway não
    aceita SVG), mas o que vai para o slide é o arquivo original.
  - Na **planilha**, o anexo é sempre só referência visual.

### Changed

- **A IA pergunta em vez de inventar quando falta informação para a ferramenta**:
  a política de uso de tools ganhou uma regra de fallback — quando o modelo não
  tem um dado obrigatório para chamar uma ferramenta (qual sala/tabela do Genie,
  período, moeda, premissas de um cálculo) ou quando a ferramenta voltou vazia/
  ambígua com mais de um caminho razoável, ele faz UMA pergunta objetiva ao
  usuário em vez de chutar um valor, escolher a fonte ao acaso ou responder com
  um palpite disfarçado de fato. Havendo um padrão claro e seguro, ele assume
  esse padrão e diz em uma frase o que assumiu (para o usuário corrigir). Reforça
  a regra de nunca apresentar como real um dado que não veio de uma ferramenta ou
  do usuário.
- **Edição por IA passa a ler o estado do client (edições não salvas)**: o tweak
  de deck (`/api/decks/:id/tweak`) editava a partir da versão PERSISTIDA no banco,
  ignorando edições manuais ainda não salvas (elementos movidos, imagem trocada,
  undo/redo). Agora o client envia sua cópia de trabalho e a edição roda sobre
  ela — a IA edita o que o usuário está vendo. Ownership/título/tema continuam
  vindo do deck do banco; um corpo ausente/malformado faz fallback para os slides
  persistidos (nunca apaga o deck). O Spreadsheet Studio é read-only por design,
  então já refletia o persistido.
- **Aceitar uma edição por IA salva na hora**: antes, aceitar uma sugestão só
  marcava o deck como "não salvo" e exigia um Save manual depois. Agora persiste
  imediatamente, com um flash "Salvo" de confirmação; em caso de falha o deck
  continua marcado como não salvo (retry pela barra Save) e a edição segue
  desfazível (undo/redo).

### Fixed

- **Troca de imagem agora reflete no export `.pptx`**: substituir a imagem de um
  elemento no editor deixava o `.pptx` (e a preview após reload) com a imagem
  ORIGINAL do design system. Ao trocar a imagem, o novo `src` era definido mas o
  marcador `data-ds-asset-id` permanecia; o `serialize()` então removia o `src`
  de todo `<img data-ds-asset-id>` e o export reinjetava o asset original do
  template. Agora, ao definir um `src` num `<img>`, o editor remove o marcador do
  DS — a imagem passa a ser tratada como customizada, o `src` é preservado e o
  export para de re-resolver.
- **Imagem não sai mais deformada no `.pptx`**: o export esticava a imagem para
  preencher a caixa do elemento (equivalente a `object-fit: fill`), deformando
  uma imagem de proporção diferente (ex.: formas quadradas numa caixa larga). Uma
  imagem com `object-fit: contain` agora é exportada com a caixa LETTERBOXED
  calculada no client (a partir da proporção natural da imagem + a caixa do
  elemento), então o `.pptx` mantém a proporção — igual à preview; `cover` usa o
  `sizing` do pptxgenjs. O frame de export passou a aguardar o decode das imagens
  para conhecer a proporção natural.
- **Anexar SVG no prompt de edição por IA falhava** (`INVALID_PARAMETER_VALUE:
  Invalid data URL`) e o logo saía como uma recriação imperfeita: a API de visão
  do gateway não aceita SVG, e o anexo fazia o modelo REDESENHAR a imagem em vez
  de usá-la. Agora o SVG é inserido como o arquivo real no slide (VETOR, via o
  fluxo de asset acima); o modelo só vê uma cópia raster para decidir onde
  colocá-lo, mantendo a transparência (um logo branco não é mais apagado por um
  fundo branco na rasterização).

## [1.1.0] - 2026-08-09

Roteamento de intenção mais inteligente: um classificador barato por turno mais um
roteador de regex mais preciso acabam com o disparo espúrio de skills/tools, e o uso
de ícones/motivos do design system fica mais comedido.

### Added

- **Classificador de intenção por turno (LLM barato + roteador híbrido)**: em
  turnos ambíguos para o roteador de regex (um briefing longo que NARRA "geração
  de slides, planilhas, documentos", ou um pedido multi-artefato), um modelo
  rápido e barato (Haiku) lê a intenção real antes da resposta — quais artefatos
  o usuário quer criar e se o turno precisa de dados internos. Isso mata o
  disparo espúrio de skills/tools (planilha/imagem/documento/Genie One) que
  apareciam só porque o texto do deck mencionava esses termos. Gating híbrido:
  chat trivial ("quanto é 2+2?") e tweaks óbvios de artefato pulam o classificador
  (TTFT permanece baixo); turnos determinísticos (resposta ao `deck-questions`)
  também. O custo (pequeno) do classificador é DISCLOSED no rodapé da mensagem e
  entra na estimativa mostrada ao usuário (coluna `intent_classify`).

### Changed

- **Roteador de capacidades por regex mais preciso (fast-path + fallback)**: os
  detectores de intenção de planilha/imagem/documento passaram a exigir o verbo
  de criação ADJACENTE ao substantivo do artefato (proximidade), e a detecção de
  intenção de dados exige fonte de dados explícita, ou possessivo/verbo colado ao
  substantivo de negócio — acaba o "bag-of-words" que ligava capacidades por uma
  palavra solta no meio de um texto longo.
- **Uso de ícones e motivos do DS mais moderado (correção de over-uso)**: ícones
  deixam de ser obrigatórios por card — um ícone só entra quando há correspondência
  SEMÂNTICA real com o item; um ícone de PRODUTO fora de contexto é explicitamente
  pior que nenhum, e a alternativa passa a ser um SVG simples de traço quando nada
  do DS combina. Motivos decorativos ficam restritos a capa/divisor/encerramento,
  no máximo um por slide e nunca em slides de conteúdo — alinhado ao uso comedido
  dos decks originais do design system.

## [1.0.1] - 2026-08-09

Rodada de qualidade nos decks e nas ferramentas: assets reais do design system,
menos ruído de ferramentas de dados, preview do DS de volta e prompt de deck mais leve.

### Added

- **Ativos reais do design system nos decks HTML**: o modelo referencia ícones,
  ilustrações/motivos e logo REAIS da marca via `<img data-ds-asset-id="ID">`
  (`<img data-ds-logo>`), resolvidos para a arte inline do DS na preview, no
  editor e no export `.pptx`. O HTML salvo guarda só o id simbólico (re-tematizável).
- **Indicador de progresso por artefato**: durante uma geração longa e silenciosa
  o chat mostra "Montando sua apresentação… / planilha… / documento… Ns" em vez de
  um "Thinking…" mudo.

### Changed

- **Genie One / ferramentas de dados suprimidas em turnos de artefato**: quando o
  turno é claramente sobre gerar um deck/planilha/documento/imagem e não há
  intenção de dados internos, as tools de dados do workspace não são anexadas —
  elimina a chamada espúria da Genie One (o "teste de conectividade") que atrasava
  e confundia a geração. Turnos que pedem dados da empresa continuam com elas.
- **Prompt de deck ~40–50% menor**: removido o schema morto do antigo motor de
  árvore semântica da `DECK_POLICY`/`templateHint`; o conteúdo/editorial ficou
  engine-agnóstico e o formato passou a ser exclusivamente o do motor HTML —
  menos time-to-first-token e menos custo por turno.

### Fixed

- **Preview do design system restaurado**: o card de "Modelos" voltou a renderizar
  o primeiro slide do primeiro template do DS (extraído e enxuto no endpoint de
  lista) em vez do placeholder de círculo + título que sobrou da remoção do motor
  de árvore.
- **Motifs/ícones inventados**: o motor HTML agora tem um canal para os assets
  reais do DS + regra dura anti-invenção — o comportamento padrão é usar o motif/
  ícone original da marca; criação livre só a pedido explícito do usuário.

## [1.0.0] - 2026-08-09

Primeira versão consolidada: chat multimodelo com artefatos e ferramentas sobre o
Databricks AI Gateway, deployável via Asset Bundle em qualquer cloud (AWS/Azure/GCP).

### Added

- **Chat multimodelo** sobre o Databricks AI Gateway, com streaming de respostas e
  reasoning nativo. Catálogo curado com Claude **Opus 5**, Gemini **3.6 Flash** e
  **Kimi K3** (Moonshot AI), entre outros, sondados ao vivo no gateway.
- **Sessões e histórico** persistidos no Lakebase, com **busca semântica** via pgvector
  (flag `HISTORY_RETRIEVAL`).
- **Anexos multimodais**: documentos, imagens e **áudio/vídeo** (transcrição/entendimento
  via Gemini no gateway, com segmentação de gravações longas no browser).
- **Mensagens estruturadas e gráficos interativos** (prism-blocks), incluindo blocos de
  gráfico com série em linha.
- **Ferramentas nativas do workspace** (tool calling): UC Functions e UDF Python embutida.
- **Estúdios de artefato** — Slides, Planilhas (.xlsx) e Documentos — com fluxo
  bloco → tabela → estúdio → tweak → export:
  - **Slides**: **motor de deck HTML puro** — o modelo escreve `<section>` HTML que flui
    contra o design system ativo, com streaming slide-a-slide, **edição manual do DOM**
    (estilo Claude Design) e export `.pptx` de **objetos nativos** (DOM→shapes), incluindo
    o embed opcional das **fontes da marca** para máxima fidelidade.
  - **Documentos**: **editor WYSIWYG** (clique-e-digite, com barra de formatação) e
    split-pane com preview rich text ao vivo, mantendo o Markdown puro como modo avançado.
- **Geração e edição de imagens** via modelos de imagem do gateway.
- **Voz**, personalização, i18n da UI e diretiva de idioma de resposta.
- **Skill "Ajuste de apresentação"**: .pptx anexado vira deck no design system.
- **Conexão a MCPs externos** via UC connections, com UX nas configurações.
- **Painel de administração e autorização** app-level (isolamento por `user_email`).
- **Dashboard de custos de IA** (AI/BI, system tables) publicado no deploy.
- **Deploy via Databricks Asset Bundle** que provisiona a stack completa (Lakebase
  serverless, Serverless SQL Warehouse, a App e o dashboard), com job pós-deploy de
  auto-configuração (role PG do service principal, UDF, volume de imagens, admin bootstrap).
- **Ambiente de desenvolvimento 100% local** sem Lakebase/OAuth: PostgreSQL + pgvector
  do Homebrew (`scripts/local-postgres.sh`, `.env.local.example`, `scripts/seed-local.mjs`)
  e scripts npm `local:up|down|status|reset|seed` + `dev:local`.
- **Documentação**: README, onboarding/deploy, custos e posicionamento, conexão de MCPs
  e Microsoft 365 via Microsoft Graph.

### Changed

- Deploy **100% cloud-agnóstico** (AWS/Azure/GCP): sem host hardcoded — o workspace vem
  do profile do CLI; Lakebase e warehouse entregues como **recursos da App**.

### Performance

- Fluidez de streaming e melhor TTFT; pooling de conexões do Lakebase; disclosure
  progressiva de capacidades para reduzir tokens.

[Unreleased]: https://github.com/pedrotramos/ai-prism/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/pedrotramos/ai-prism/releases/tag/v1.0.0
