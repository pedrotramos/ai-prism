<!-- i18n: source=docs/user-guide.md source-hash=5769182a6802d0834db90fb1e55c2a176b556937 status=outdated -->
# Guia do usuário

[English](../user-guide.md) · **Português (Brasil)** · [Español](../es/user-guide.md)

> Esta tradução está desatualizada: a [versão em inglês](../user-guide.md) tem a seção de gráficos mais recente (tabela dinâmica, mapa de calor, dispersão e histograma).

Como se localizar no AI Prism. Cada seção cobre uma parte da tela; as seções
do compositor, do chat e do shell do app entram ao lado desta.

## Shell

O shell é tudo o que fica em volta de uma conversa: a barra superior, os links
para uma conversa, as notificações e o que acontece quando algo falha.

### A barra superior

A barra acima da conversa tem, da esquerda para a direita:

| Controle | O que faz |
|---|---|
| Menu (só no celular) | Abre a lista de conversas. |
| Modelo | O modelo que responde nesta conversa. A lista mostra primeiro três modelos **Recomendados**. **Mais modelos** abre o resto do catálogo, agrupado por provedor, com uma caixa de busca. Um modelo marcado **Só texto** não aceita imagens (ou **Imagens**, quando a maior parte do seu catálogo é só texto). |
| Tools | As ferramentas que o modelo pode chamar nesta conversa (Genie One, geração de imagens, Genie Agents, funções do Unity Catalog, índices de Vector Search, conexões MCP). O número no ícone é quantas estão ligadas. |
| Taxímetro | Quanto você gastou neste mês e, dentro de uma conversa, quanto ela custou até agora, a preço de tabela. No celular aparece só o ícone do medidor; toque nele para ver os valores. |
| Configurações | Preferências, skills, conexões MCP e, para admins, as configurações da organização. |

Os painéis de Modelo, Tools e Taxímetro fecham com **Esc** ou com um clique fora, e o foco do
teclado volta para o botão que os abriu. Na lista de modelos, as setas do teclado passam de um
modelo para outro. O painel de custos também fecha quando você troca de conversa ou usa os botões
de voltar e avançar do navegador.

As escolhas de modelo e de tools ficam salvas na conversa: ao reabri-la, elas voltam.

### Links para uma conversa

Cada conversa tem o próprio endereço (`…/#/chat/<id>`), então dá para salvá-la nos favoritos ou
usar voltar e avançar do navegador. `…/#/history` abre a lista de todas as conversas.

Se um link aponta para uma conversa que não existe, foi excluída ou não é sua, o AI Prism mostra
**Conversa não encontrada** e oferece **Voltar ao histórico** e **Nova conversa**. Ele nunca abre a
conversa de outra pessoa: toda leitura é limitada ao usuário conectado.

### Quando algo dá errado

**Um turno falha.** Se o modelo ou o serviço não conseguem responder (por exemplo, o AI Gateway
está temporariamente indisponível), sua mensagem continua na conversa e um cartão de erro aparece
no lugar da resposta. O cartão diz o que aconteceu em palavras simples e oferece:

- **Tentar de novo**: pede de novo. Se o servidor já guardou sua mensagem, ele gera a resposta que
  faltou; se não, envia a mensagem de novo com os mesmos anexos.
- **Copiar prompt**: copia sua mensagem, caso prefira reescrevê-la.
- **Detalhes**: a mensagem exata do servidor, útil para reportar o problema a um admin.

O mesmo cartão aparece quando **Regenerar** ou **Gerar resposta** falham. Quando uma regeneração
falha antes de uma nova resposta ser guardada, a versão anterior continua.

**Uma mensagem não pode ser exibida.** Se uma mensagem guardada estiver malformada, só ela é
trocada por "Não foi possível exibir esta mensagem." O resto da conversa continua funcionando.

**Algo quebra a página inteira.** Aparece "Algo deu errado" com um botão **Recarregar**. Suas
conversas ficam guardadas no servidor, então recarregar não perde nada que já foi enviado.

**Notificações.** Mensagens curtas aparecem no canto superior direito e somem sozinhas após alguns
segundos (os erros ficam um pouco mais). Apontar para a notificação, ou levar o foco do teclado até
ela, a mantém aberta para você ler os **Detalhes**. Leitores de tela as anunciam; erros são
anunciados na hora.

#### O que as mensagens de erro querem dizer

| Mensagem | Causa comum | O que fazer |
|---|---|---|
| Não foi possível conectar ao AI Prism | Sua rede, VPN ou proxy derrubou a conexão. | Verifique a conexão e tente de novo. |
| O serviço está temporariamente indisponível | O AI Gateway, o workspace ou o banco não responderam. | Tente de novo em instantes. |
| Muitas solicitações agora | Limite de taxa do endpoint do modelo ou do AI Prism. | Aguarde alguns segundos e tente de novo. |
| Sua sessão expirou | O token de login do proxy do Databricks Apps expirou. | Recarregue a página. |
| Você não tem permissão para isso | Falta um grant ao seu usuário (catálogo, Genie Agent, endpoint). | Peça ao admin do workspace. |
| Grande demais para enviar | Um arquivo ou mensagem acima do limite de upload. | Envie um arquivo menor ou divida-o. |
| Demorou demais e foi interrompido | Uma chamada de modelo ou tool atingiu o tempo limite. | Tente de novo, ou peça algo menor. |
| Algo deu errado no servidor | Um erro inesperado no servidor. | Tente de novo; se repetir, envie os **Detalhes** ao seu admin. |

## Navegação

### A barra lateral

A barra lateral à esquerda reúne tudo o que você precisa para se mover pelo
app, nesta ordem:

1. **Nova conversa** abre uma conversa vazia. O logo do AI Prism no topo faz
   o mesmo.
2. **Buscar conversas** abre a página de Histórico com a caixa de busca
   pronta.
3. **Suas conversas**, das mais novas para as mais antigas, agrupadas em Hoje,
   Ontem, Últimos 7 dias, Últimos 30 dias e Mais antigas. Selecione um título
   para abri-lo. Passe o mouse sobre uma linha, ou chegue até ela pelo teclado,
   para ver **Renomear** e **Excluir**.
4. **Sua conta e as Configurações**, no canto inferior esquerdo: o e-mail com
   que você entrou e a engrenagem que abre as Configurações. No celular é por
   ela que se chega às Configurações: a engrenagem fecha a barra lateral e as
   abre.

Enquanto a lista carrega, aparecem linhas cinza do mesmo tamanho, para que
nada pule quando as conversas chegam. Sem nenhuma conversa ainda, a lista
avisa e oferece **Começar a primeira conversa**.

### Barra lateral recolhida

No computador, a seta ao lado do logo recolhe a barra lateral em um trilho
estreito com as mesmas ações em ícones: expandir, Nova conversa, Buscar
conversas, Configurações e sua conta. Passe o mouse sobre um ícone para ver o
nome. A escolha fica salva neste navegador.

### No celular

No celular a barra lateral fica escondida. Abra pelo botão de menu no canto
superior esquerdo da tela. Enquanto ela está aberta:

- o resto da tela fica escurecido e não pode ser usado;
- o teclado fica dentro da barra lateral (Tab e Shift+Tab circulam por ela);
- **Esc**, o botão de fechar ou um toque na área escurecida a fecham, e você
  volta para onde estava.

A linha da conversa aberta mostra os botões Renomear e Excluir. Para renomear
ou excluir outras conversas, use a página de Histórico, onde todas as linhas
os mostram.

### Histórico

A página de Histórico lista todas as conversas e permite:

- **buscar por assunto**: a busca é semântica, então encontra uma conversa
  pelo tema, não só pelas palavras do título. Cada resultado mostra um
  percentual de correspondência. **Esc** ou o botão de limpar esvaziam a
  busca;
- **ordenar** das mais novas ou das mais antigas;
- **selecionar** conversas pelas caixas de seleção (ou **Selecionar tudo**) e
  excluí-las de uma vez;
- **renomear** ou **excluir** uma conversa pelos botões no fim da linha.

Quando a busca não encontra nada, a página sugere outras palavras e oferece
**Limpar busca**. Sem nenhuma conversa, oferece **Nova conversa**.

### Começando uma conversa

Uma conversa nova abre com uma saudação e algumas sugestões para começar:
fazer uma pergunta aos dados da empresa, criar uma apresentação, montar uma
planilha, redigir um documento, gerar uma imagem e ajuda para escrever. A
primeira sugestão fica em destaque como o ponto de partida mais útil.

Escolher uma sugestão preenche a caixa de mensagem com o começo de um pedido,
por exemplo "Crie uma apresentação de 6 slides sobre ", e deixa o cursor no
fim. Complete a frase e envie, ou ajuste antes.

Só aparecem as sugestões que funcionam nesta instalação: a sugestão de dados
precisa de uma ferramenta de dados (como o Genie One) que o administrador
permita e que esteja ligada no menu Ferramentas; a de imagem precisa de um
modelo de imagem e da ferramenta de imagem.

### Idioma e tema

A interface está disponível em inglês, português do Brasil e espanhol. Com o
idioma da interface em **Padrão (navegador)** (Configurações, Preferências),
o AI Prism segue o idioma do navegador. Se o navegador usar qualquer outro
idioma, a interface aparece em inglês.

Trocar entre os temas claro e escuro faz as cores mudarem suavemente em
200 ms. Se o sistema operacional estiver configurado para reduzir movimento,
a troca é instantânea.

### Teclado

| Tecla | Onde | O que faz |
|---|---|---|
| Tab / Shift+Tab | em qualquer lugar | Passa de um controle a outro; um anel de foco mostra onde você está |
| Esc | barra lateral no celular | Fecha a barra lateral |
| Esc | busca do Histórico | Limpa a busca |
| Esc | renomeando uma conversa | Cancela a renomeação |
| Enter | renomeando uma conversa | Salva o novo nome |

## Compositor

O compositor é a caixa de mensagem na parte de baixo de cada conversa. Escreva
o pedido, anexe o que o modelo deve ler e envie.

### Escrever e enviar

- **Enter** envia a mensagem. **Shift+Enter** quebra a linha.
- A caixa cresce com o texto, até umas oito linhas; depois disso, rola.
- Sua mensagem aparece na conversa assim que você envia, antes de a resposta
  começar.
- Enquanto a resposta está sendo escrita, o botão Enviar vira **Parar**.
- Nada pede confirmação: a mensagem é enviada e o comando roda na hora.

### Adicionar arquivos e imagens

Selecione **+** (à esquerda da caixa) para abrir um menu curto:

| Item | O que faz |
|---|---|
| **Anexar documentos** | Escolhe documentos, planilhas, PDFs ou imagens. O texto deles é lido e enviado com a mensagem. |
| **Adicionar imagens** | Escolhe só imagens: capturas de tela, fotos, diagramas. Modelos com visão olham para elas. |
| **Adicionar áudio ou vídeo** | Aparece só quando o workspace transcreve mídia. A gravação vira texto antes de o modelo ler. |
| **Comandos** | Abre o menu de comandos (o mesmo que digitar `/`). |

Você também pode **colar** uma captura de tela ou um arquivo copiado na caixa,
ou **arrastar e soltar** arquivos sobre o compositor. Cada anexo aparece como
um chip acima da caixa; imagens mostram uma miniatura. Remova um anexo pelo
botão **×** dele. Uma mensagem aceita até 10 anexos.

### Comandos

Digite `/` no início da caixa para abrir o menu de comandos. Continue
digitando para filtrar. Cada comando tem um nome em cada idioma da interface,
e os acentos são opcionais: `/historico`, `/histórico`, `/history` e
`/historial` funcionam. Espaços extras no fim são ignorados.

| Comando (pt · en · es) | O que faz |
|---|---|
| `/compactar` · `/compact` · `/compactar` | Resume a conversa até aqui para liberar contexto. O texto depois do comando diz ao resumo o que manter, por exemplo `/compactar mantenha os números`. |
| `/contexto` · `/context` · `/contexto` | Mostra quanto do contexto do modelo esta conversa usa. |
| `/nova` · `/new` · `/nueva` | Começa uma nova conversa. |
| `/modelo` · `/model` · `/modelo` | Lista os modelos; escolha um para trocar o desta conversa. O texto depois do comando filtra a lista, por exemplo `/modelo sonnet`. |
| `/skills` | Abre suas skills nas Configurações. |
| `/custo` · `/cost` · `/costo` | Mostra quanto esta conversa custou. |
| `/historico` · `/history` · `/historial` | Abre o histórico de conversas. |
| `/configuracoes` · `/settings` · `/ajustes` | Abre as Configurações. |
| `/ajuda` · `/help` · `/ayuda` | Lista os comandos disponíveis aqui e os atalhos de teclado. |

O menu só lista os comandos que funcionam na sua instalação. Um comando
indisponível, ou qualquer outro texto que comece com `/`, vai para o modelo
como uma mensagem comum.

### Voz

- O **microfone** dita na caixa, no idioma da interface. Selecione de novo
  para parar.
- O botão de **onda sonora** abre o modo de voz, uma conversa falada com o
  modelo.

O ditado precisa de um navegador com reconhecimento de fala, como Chrome ou
Edge.

### Teclado e acessibilidade

| Tecla | Onde | Ação |
|---|---|---|
| Enter | caixa de mensagem | envia, ou escolhe o comando destacado |
| Shift+Enter | caixa de mensagem | nova linha |
| `/` | início da caixa | abre o menu de comandos |
| ↑ / ↓ | menu de comandos | move o destaque |
| Tab | menu de comandos | escolhe o comando destacado |
| Esc | qualquer menu ou a ajuda | fecha; o texto continua |
| Enter, Espaço ou ↓ | botão **+** | abre o menu no primeiro item |
| ↑ / ↓, Home / End | menu **+** | move entre os itens |

O compositor funciona sem mouse. Leitores de tela anunciam a caixa como uma
caixa de combinação: quando `/` abre as sugestões, leem quantas são e leem a
destacada conforme você navega com as setas. Shift+Enter continua quebrando a
linha. Os botões têm pelo menos 44 px de altura no celular e 32 px em telas
maiores. O elemento com foco sempre mostra um contorno visível.

## Chat: mensagens e respostas

### Lendo uma resposta enquanto ela chega

- A resposta aparece à medida que o modelo escreve. Um cursor piscando indica
  que ainda está chegando texto.
- Quando o modelo chama uma ferramenta (Genie One, um agente Genie, uma função
  do Unity Catalog, um índice de vector search, Python, um servidor MCP), um
  **chip de ferramenta** aparece naquele ponto da resposta. Ele sempre mostra
  o estado:

  - **Em execução**: um indicador girando e os segundos decorridos.
  - **Concluída**: um sinal de check e quanto tempo a chamada levou.
  - **Falhou**: um sinal de alerta, quanto tempo levou e a primeira linha do
    erro, para você ver o que deu errado sem abrir o chip.

  Clique no chip para ver o que foi perguntado (a pergunta, a consulta ou o
  código) e o que voltou.
- **Pensando…** aparece só quando nada mais indica que o turno continua
  trabalhando, por exemplo enquanto o modelo decide o que fazer com o
  resultado de uma ferramenta. Nunca aparece ao lado de um chip em execução.
- Se o modelo transmite o raciocínio, ele aparece num painel **Raciocínio**
  acima da resposta. O painel fica aberto enquanto o modelo raciocina e se
  recolhe quando a resposta começa. Clique para abrir ou fechar de novo.
- Leitores de tela anunciam a resposta quando ela termina, não token a token.

### Código e tabelas

- Blocos de código mostram a linguagem no canto superior esquerdo. **Copiar**
  copia o código exatamente como está. O botão de quebra de linha quebra as
  linhas longas em vez de rolá-las para o lado; pressione de novo para voltar.
- Tabelas rolam dentro do próprio quadro e mantêm o cabeçalho visível durante
  a rolagem. Pelo teclado, chegue à tabela com Tab e use as setas.

### Gráficos

- As cores das séries seguem o tema do app e o design system escolhido pela
  sua organização. Quando um gráfico compara duas séries, como o trimestre
  passado e o atual, a anterior fica cinza e a atual, colorida.
- **Ver dados** abre os números do gráfico como tabela. O botão de download
  salva o gráfico em PNG.
- Leitores de tela leem o título do gráfico, as séries e o número de
  categorias.

### Arquivos gerados: decks, planilhas e documentos

Todo arquivo gerado aparece como um card com o mesmo layout: um ícone, o
título, uma descrição curta (número de slides, de abas, tipo de documento) e
as ações. A ação principal abre o arquivo no estúdio dele. O card de planilha
também tem **Download** para o arquivo `.xlsx`. O card de documento mostra o
primeiro parágrafo do documento. Quando o chat fica numa coluna estreita ao
lado de um estúdio aberto, as ações descem para baixo do título, e o título
continua legível.

O modelo também pode criar esses arquivos com uma chamada de ferramenta
enquanto responde (**Create deck**, **Create spreadsheet**, **Create
document**, e **Update …** para revisar um arquivo do mesmo chat). A
ferramenta aparece como um chip na resposta; um deck é montado slide a slide
enquanto o chip roda, e o card aparece onde a ferramenta foi chamada. Uma
atualização cria uma nova versão do arquivo: a resposta anterior mantém a
versão que mostrou. Um arquivo só passa a existir quando a resposta é salva: se
você interromper a resposta, nenhum arquivo dela fica. Uma ferramenta que falha
(por exemplo, atualizar um arquivo que o modelo não encontra) mostra um chip
vermelho e a resposta continua.

### Quando uma resposta para antes ou falha

- **O turno parou antes** (o modelo repetiu a mesma chamada ou atingiu o
  limite de rodadas de ferramentas ou de tempo): uma nota azul abaixo da
  resposta explica o motivo. A resposta acima usa os dados obtidos até ali.
  **Tentar de novo** gera a resposta outra vez; para continuar de onde parou,
  envie uma nova mensagem.
- **A resposta veio incompleta ou falhou** (o limite de saída foi atingido ou
  o AI Gateway retornou um erro): uma nota vermelha explica o que aconteceu,
  com **Tentar de novo**.
- **Nenhuma resposta chegou**: a linha diz isso em vez de ficar vazia.
- **Uma parte da resposta não pode ser exibida** (um gráfico, uma tabela ou um
  card de arquivo com dados quebrados): só essa parte vira uma nota, "Não foi
  possível exibir esta parte da mensagem.", com **Detalhes**. O resto da resposta continua aparecendo.
- Copiar, Ouvir, Exportar PDF e Regenerar aparecem só abaixo de uma resposta
  concluída, com conteúdo, que não falhou. Abaixo de uma resposta que falhou,
  mesmo com parte do texto, **Tentar de novo** na nota vermelha é a única ação;
  você ainda pode selecionar o texto e copiá-lo manualmente.

### Ações das mensagens

- Abaixo de cada resposta: **Copiar**, **Ouvir**, **Exportar PDF** e
  **Regenerar**. Se você regenerou uma resposta, as setas alternam entre as
  versões.
- Nas suas mensagens, **Editar** e **Copiar mensagem** aparecem quando você
  passa o mouse sobre a mensagem ou leva o foco do teclado até ela. No celular
  ou tablet, toque na mensagem para mostrá-las e toque de novo para escondê-las.
- Toda ação tem um nome anunciado por leitores de tela e uma área de toque de
  pelo menos 32 × 32 px com mouse e 44 × 44 px em telas de toque.

## Configurações

Abra as Configurações pela engrenagem na barra superior ou no rodapé da barra
lateral, ou com `/settings`. Elas abrem como um diálogo: o foco entra nele, Tab
e Shift+Tab ficam lá dentro, e Escape, o botão de fechar ou **Concluído** fecham
o diálogo e devolvem o foco ao botão que o abriu.

### Seções

As seções ficam agrupadas para nunca passarem de sete:

| Grupo | Seções | Quem vê |
|---|---|---|
| Pessoal | Preferências, Conexões MCP | todos |
| Workspace | Skills, Design system | todos |
| Administração | Modelos (LLM), Ferramentas, Administradores | admins |

- **Preferências** reúne aparência, idioma da interface e das respostas,
  notificações e o tom da resposta com o prompt de sistema. O modelo de imagem
  fica em **Avançado**, já definido como o modelo recomendado da organização.
- **Ferramentas** liga ou desliga grupos de ferramentas para a organização e,
  logo abaixo, gerencia o **Catálogo MCP** que os usuários podem conectar.
- No celular, dois botões no topo escolhem **Pessoal** ou **Organização**, e as
  seções dessa área rolam para o lado logo abaixo.

### Salvamento e erros

- Os controles de ligar e desligar são chaves que os leitores de tela anunciam
  com o estado.
- Cada rótulo fica acima do campo. Um valor que não pode ser salvo, como um
  preço negativo, é marcado no campo com o motivo, e nada é salvo até ser
  corrigido.
- Depois que uma alteração é salva, **Salvo** aparece ao lado dela. Quando o
  salvamento falha, o erro fica ao lado da alteração até a próxima tentativa.
- **Modelos (LLM)** mostra cada modelo em uma linha. Use a seta ao lado do nome
  para abrir o nome de exibição, a descrição e os preços.

## Projetos

Um projeto reúne conversas, instruções e arquivos de referência, e pode ser
compartilhado com pessoas e grupos do workspace. As telas chegam com a interface
de projetos; esta seção descreve as regras que elas seguem (a API é `/api/projects`).

### Papéis

Cada membro tem um papel. Um papel mais alto faz tudo o que um mais baixo faz.

| Ação | view | manage | owner |
|---|---|---|---|
| Ler o projeto, os arquivos e as conversas | sim | sim | sim |
| Mandar mensagens nas conversas do projeto, começar uma conversa nele | sim | sim | sim |
| Mudar o que já está numa conversa do projeto: editar um prompt enviado, regenerar uma resposta, trocar a versão exibida, responder às perguntas do assistente, compactar a conversa | | sim | sim |
| Trazer uma conversa sua para o projeto | sim | sim | sim |
| Editar nome, descrição e instruções | | sim | sim |
| Adicionar ou remover arquivos | | sim | sim |
| Adicionar, mudar ou remover membros (até **manage**) | | sim | sim |
| Tornar alguém owner, mudar ou remover um owner | | | sim |
| Excluir o projeto | | | sim |

- Quem cria o projeto é o primeiro owner. Um projeto sempre mantém pelo menos uma
  pessoa (não um grupo) como owner, então o último owner não pode sair nem ser
  rebaixado.
- Qualquer membro pode sair do projeto.
- Membros são pessoas (o e-mail) ou grupos do workspace (o nome do grupo). Um grupo
  só vale enquanto o workspace confirma que você faz parte dele: se essa checagem
  falhar, o grupo não dá acesso nenhum até voltar a funcionar.
- Admins do app não têm acesso especial a projetos. Só veem um projeto se forem
  membros.

### Conversas num projeto

- Uma conversa num projeto pertence ao projeto. Todo membro lê e pode mandar
  mensagens nela. Enquanto a resposta de alguém está sendo escrita, os outros veem
  quem mandou, e uma segunda mensagem espera essa resposta terminar.
- O acesso segue o seu papel atual. Se você sair do projeto, ou for removido, perde
  as conversas dele, inclusive as que você começou.
- Quem começou uma conversa pode tirá-la do projeto, de volta para as próprias
  conversas, se tiver **manage** ou **owner**.
- Excluir um projeto exclui as conversas dele.
- O período de retenção de conversas da organização não vale para conversas de
  projeto: elas ficam até serem excluídas ou o projeto ser excluído.

### Arquivos

Os arquivos de um projeto ficam guardados como texto (PDF, Word, PowerPoint, Excel
e formatos de texto, como os anexos do chat). Até 10 arquivos de 25 MB por envio, e
50 arquivos por projeto.
