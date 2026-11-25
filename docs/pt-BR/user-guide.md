<!-- i18n: source=docs/user-guide.md source-hash=5f92cd8fa296d8a6d78f68d804a204c490c6ca44 status=current -->
# Guia do usuário

[English](../user-guide.md) · **Português (Brasil)** · [Español](../es/user-guide.md)

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
| Título | O nome da conversa aberta. Na página de um projeto é uma trilha, como **Projetos / Revenue analytics**; selecione **Projetos** para voltar. |
| Compartilhar | Coloca a conversa em um projeto e abre os membros desse projeto (veja [Compartilhar uma conversa](#compartilhar-uma-conversa)). Só dentro de uma conversa. |
| Selo de custo | Quanto você gastou no mês; dentro de uma conversa mostra quanto esta conversa custou. Selecione para ver o detalhamento. No celular aparece só o ícone do medidor; toque nele para ver os valores. |
| Painel de artefatos | Mostra ou oculta o painel com o deck, a planilha ou o documento desta conversa. Só quando a conversa tem um. |
| Configurações | Preferências, skills, conexões MCP e, para admins, as configurações da organização. |

O modelo, as ferramentas e o estilo da resposta não ficam na barra superior: ficam dentro da caixa de
mensagem (veja [Os seletores](#os-seletores)).

O painel de custo fecha com **Esc** ou com um clique fora, e o foco do teclado volta ao botão que o abriu.
Ele também fecha quando você troca de conversa ou usa os botões de voltar e avançar do navegador. Mostra o
**Gasto no mês** com a data em que renova e, dentro de uma conversa, **Esta conversa** com o número de
respostas e o custo delas. Todo valor é uma estimativa a preço de tabela, registrada a cada chamada ao
modelo. O valor faturado está no dashboard de custos da sua organização.

As escolhas de modelo, ferramentas e estilo ficam salvas na conversa: ao reabri-la, elas voltam.

### Esforço de raciocínio

Alguns modelos conseguem pensar mais antes de responder. Quando o modelo selecionado oferece isso, a lista
dele mostra o controle **Esforço de raciocínio**: **Automático**, **Baixo**, **Médio** ou **Alto**. Quanto
maior o esforço, mais lenta e mais cara a resposta (os tokens de raciocínio são cobrados como saída); por
isso deixe em **Automático**, a menos que uma pergunta precise de mais. Em **Automático**, o AI Prism não
envia nada extra e o modelo se comporta como de costume. A escolha vale para as mensagens que você enviar
a seguir, inclusive **Continuar** e **Regenerar**, e não fica salva na conversa: uma nova aba do navegador
começa em **Automático**. Escolha um modelo sem o controle e também não é enviado nada.

As descrições dos modelos na lista seguem o idioma da interface (inglês, português ou espanhol). Uma
descrição que um admin editou em **Configurações → Modelos** aparece como foi escrita.

### Compartilhar uma conversa

**Compartilhar** (na barra superior e no cabeçalho de cada estúdio) coloca a conversa em um projeto, para
que os membros do projeto possam lê-la, e depois abre os membros do projeto para você adicionar pessoas.

- Numa conversa pessoal, primeiro pergunta para qual projeto movê-la. Todos do projeto verão a conversa.
  Se você ainda não está em nenhum projeto, o diálogo avisa.
- Uma conversa que já está num projeto vai direto aos membros do projeto e não move nada.
- Se a lista de projetos ainda estiver carregando quando você selecionar **Compartilhar**, o clique espera
  por ela. Se a lista não puder ser carregada, um erro avisa e a conversa fica onde está.
- Compartilhar fecha o estúdio de documentos quando há edições manuais não salvas, usando a pergunta do
  próprio estúdio, como ao fechá-lo: **Continuar editando**, **Salvar** ou **Descartar alterações**.
  **Continuar editando** mantém seu rascunho e nada se move: a conversa não vai para um projeto e a tela
  de membros não abre. No estúdio de slides, **Compartilhar** fica oculto enquanto o deck está no modo
  **Editar**; salve ou descarte as edições e saia desse modo antes de compartilhar. Um estúdio sem edições
  não salvas continua aberto. O estúdio de planilhas é somente leitura, então não pergunta.
- Os papéis são os de [Projetos](#papéis). Um chat temporário não pode ser movido para um projeto.

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

A barra lateral à esquerda lista tudo de que você precisa para se mover, nesta
ordem:

1. **Nova conversa** começa uma conversa vazia. O logotipo do AI Prism no topo
   faz o mesmo.
2. **Buscar conversas** abre a página Histórico com a caixa de busca pronta.
3. **Projetos**, **Agentes** e **Custos**. **Agentes** aparece quando os
   agentes agendados estão ligados na sua organização; **Custos** é só para
   admins.
4. **Seus projetos**, cada um com um pontinho colorido e um **+** que começa uma
   conversa dentro dele, seguidos das **suas conversas**, da mais nova para a
   mais antiga, agrupadas em Hoje, Ontem, Últimos 7 dias, Últimos 30 dias e
   Mais antigas. Selecione um título para abrir. Passe o mouse sobre uma linha,
   ou chegue nela pelo teclado, para mostrar **Mover para projeto**,
   **Renomear** e **Excluir**.
5. **O que você gastou no mês**, acima da sua conta: o total do mês e a nota
   "Estimativa a preço de tabela". É o mesmo valor do selo de custo, e cada
   usuário vê o seu. Se não puder ser carregado, avisa e oferece **Tentar de
   novo**; um valor desatualizado fica marcado.
6. **Sua conta**, embaixo à esquerda: o e-mail com que você entrou, um botão que
   alterna entre o tema claro e o escuro e a engrenagem que abre as
   Configurações. No celular, a engrenagem fecha a barra lateral e abre as
   Configurações.

Enquanto a lista carrega, você vê linhas cinzas do mesmo tamanho, para nada
pular quando as conversas chegam. Sem conversas ainda, a lista avisa e oferece
**Começar a primeira conversa**.

### Barra lateral recolhida

No computador, a seta ao lado do logotipo recolhe a barra lateral num trilho
estreito com as mesmas ações em ícones: expandir, Nova conversa, Buscar
conversas, Projetos, Agentes, Custos, o tema, Configurações e sua conta. Passe
o mouse sobre um ícone para ver o nome. Sua escolha fica guardada neste
navegador.

A barra lateral vira trilho por conta própria quando a janela tem 1100 px ou
menos. Passe o mouse ou o foco sobre o trilho e a barra completa abre por cima
da conversa; **Esc** fecha.

### No celular

No celular (760 px ou menos) a barra lateral fica oculta. Abra-a com o botão de
menu no canto superior esquerdo da tela. Enquanto ela está aberta:

- o resto da tela escurece e não pode ser usado;
- o teclado fica dentro da barra lateral (Tab e Shift+Tab percorrem o conteúdo
  em ciclo);
- **Esc**, o botão de fechar ou um toque na área escurecida a fecham, e você
  volta ao ponto em que estava.

A linha da conversa aberta mostra os botões Mover para projeto, Renomear e
Excluir. Para renomear ou excluir outras conversas, use a página Histórico,
onde toda linha os mostra.

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

Uma nova conversa é a tela Início: uma saudação ("O que vamos analisar?", com
seu primeiro nome quando ele puder ser lido do seu e-mail), uma linha dizendo o
que você pode pedir, a caixa de mensagem e três cartões de início:

- **Analisar dados**: faça uma pergunta sobre os dados a que você tem acesso;
- **Criar um artefato**: um deck, um documento ou uma planilha, prontos para
  editar;
- **Pesquisar documentos**: encontre respostas nos seus documentos e políticas.

Selecionar um cartão preenche a caixa de mensagem com o começo de um pedido, por
exemplo "Crie uma apresentação de 5 slides sobre ", e põe o cursor no fim.
Termine a frase e envie, ou mude antes.

Acima da caixa de mensagem, **Sem projeto** permite começar a conversa dentro de
um projeto (ela passa a usar as instruções e os arquivos do projeto). Abaixo
dos cartões, **Continue de onde parou** lista as suas conversas mais recentes;
selecione uma para abri-la (até três).

### Chats temporários

Para uma conversa que não deve deixar rastro, abra o menu **+** da caixa de
mensagem e escolha **Chat temporário**. A próxima mensagem que você enviar abre
uma conversa que se comporta como qualquer outra enquanto está aberta, com uma
diferença: nada fica guardado depois.

- Ela é **apagada quando você sai**: ao começar uma nova conversa, abrir outra
  ou fechar a aba.
- Ela **não aparece em busca**: nunca surge nos resultados de busca nem no
  Histórico, e não é usada para achar conversas relacionadas.
- Ela não ensina nada à **Memória**: nenhum fato é aprendido dela. Sua memória
  já salva continua valendo nas respostas, porque é sua.
- Ela é marcada com um cadeado e **Temporário** na barra lateral e no topo da
  conversa.

Se uma aba morrer antes de a conversa poder ser apagada, o servidor a apaga
depois de 24 horas sem atividade, seja qual for a configuração de retenção. Um
chat temporário não pode ser movido para um projeto, e uma conversa comum não
pode virar temporária (nem o contrário). Os administradores veem apenas quantos
chats temporários foram iniciados, nunca quem os iniciou, os títulos ou o
conteúdo.

### Idioma e tema

A interface está disponível em inglês, português do Brasil e espanhol. Com o
idioma da interface em **Padrão (navegador)** (Configurações, Preferências),
o AI Prism segue o idioma do navegador. Se o navegador usar qualquer outro
idioma, a interface aparece em inglês.

O tema segue o seu sistema (claro ou escuro) até você escolher um: use o botão de lua no
fim da barra lateral, ou **Aparência** em Configurações → Preferências, que oferece **Sistema**, **Claro**
e **Escuro**.
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

### Os seletores

O modelo, as ferramentas e o estilo da resposta são escolhidos dentro da caixa de mensagem, ao lado do
texto que você está escrevendo. Da esquerda para a direita, embaixo da caixa:

| Controle | O que faz |
|---|---|
| **+** | Anexar arquivos, adicionar imagens, começar um chat temporário, abrir os comandos (veja abaixo). |
| Ferramentas | As ferramentas que o modelo pode chamar nesta conversa (Genie One, geração de imagem, Python, Genie Agents, funções do Unity Catalog, índices do Vector Search, conexões MCP). O botão mostra os ícones do que está ligado e quantos são. O painel tem **Tools habilitadas**, com uma chave para cada uma, e **Adicionar tools**: Genie Agents, funções do Unity Catalog e índices do Vector Search abrem cada um uma lista para escolher, e MCPs externos lista as suas conexões. O que você escolhe aparece como chips removíveis acima da caixa. Tudo roda com o seu login, e o admin define o que aparece. |
| Estilo da resposta | **Padrão**, **Conciso**, **Executivo**, **Engenheiro**, **Analista de dados** ou **Professor**, cada um com uma descrição de uma linha, mais **Instruções pessoais** (o seu próprio texto, das Configurações). O estilo fica salvo na conversa. |
| Modelo | O modelo que responde nesta conversa, com a marca do provedor. A lista mostra primeiro os **Recomendados**, o modelo com que as novas conversas começam tem a etiqueta **Padrão**, e cada modelo mostra uma descrição curta e barras com o custo relativo por resposta. **Mais modelos** abre o resto do catálogo, com uma caixa de busca. Um modelo marcado como **Só texto** não aceita imagens (ou **Imagens**, quando a maioria dos modelos do seu catálogo é só texto). |
| Microfone e onda sonora | Ditado e modo de voz (veja Voz). |
| Enviar | Envia a mensagem. Vira **Parar** enquanto uma resposta está sendo escrita. |

Os painéis de Ferramentas, Estilo e Modelo fecham com **Esc** ou com um clique fora, e o foco do teclado
volta ao botão que os abriu. Na lista de modelos, as setas movem entre os modelos. No celular cada controle
mostra só o ícone, e os painéis cabem na tela.

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
| `/skills` | Abre suas skills nas Configurações. As skills nativas (apresentações, planilhas, gráficos, imagens, documentos) aparecem primeiro, somente leitura, no idioma da interface. |
| `/custo` · `/cost` · `/costo` | Mostra quanto esta conversa custou. |
| `/historico` · `/history` · `/historial` | Abre o histórico de conversas. |
| `/configuracoes` · `/settings` · `/ajustes` | Abre as Configurações. |
| `/ajuda` · `/help` · `/ayuda` | Lista os comandos disponíveis aqui e os atalhos de teclado. |

O mesmo menu traz ainda atalhos que começam um pedido de artefato ou de ferramenta. Eles só preenchem a
caixa (nada é enviado) e você termina a frase:

| Atalho (pt) | Preenche com |
|---|---|
| `/deck` | "Crie uma apresentação sobre " |
| `/memo` | "Escreva um memorando sobre " |
| `/planilha` | "Monte uma planilha com " |
| `/imagem` | "Gere uma imagem de " |
| `/genie` | "Usando os dados da minha empresa, " |
| `/python` | "Usando Python, " |

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
- Cada resposta começa com um cabeçalho: a marca do AI Prism e uma linha como "com Genie One, Python e
  Vector Search", montada a partir das ferramentas que o turno realmente usou.
- Quando o modelo raciocina ou chama uma ferramenta (Genie One, um agente Genie, uma função do Unity
  Catalog, um índice de vector search, Python, um servidor MCP), as etapas se juntam num único cartão
  recolhível acima do texto. Enquanto o turno trabalha, uma linha fina em espectro corre por ele (ela
  fica parada se o seu sistema pede movimento reduzido). Quando termina, o cartão diz **Analisou por 4,8s
  em 2 etapas** e lista cada etapa com o tempo que levou e o estado: em execução, concluída ou falha, com
  a primeira linha do erro, para você ver o que deu errado sem abrir o cartão. **Ver detalhes** mostra o
  que foi perguntado e o que voltou; no Genie há também **Ver SQL gerado**, e no Python **Ver código**.
  Os nomes das ferramentas (Busca na web, Gerador de imagem, as ferramentas de documento, deck e planilha)
  seguem o idioma da sua resposta.
- Uma resposta tem até 12 blocos (gráficos, tabelas, decks, documentos, imagens).
  Se o modelo escrever mais, os extras ficam de fora e uma nota no fim da resposta
  diz quantos; peça o restante em uma nova mensagem.
- **Pensando…** aparece só quando nada mais indica que o turno continua
  trabalhando, por exemplo enquanto o modelo decide o que fazer com o
  resultado de uma ferramenta. Nunca aparece ao lado de uma etapa em execução.
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

- Um gráfico fica num quadro com o título e o subtítulo (por exemplo a fonte) no alto e **Exportar como
  imagem (PNG)** embaixo. As cores das séries seguem o tema do app e o design system escolhido pela sua
  organização. Quando um gráfico compara duas séries, como o trimestre passado e o atual, a anterior fica
  cinza e a atual, colorida.
- O seletor no canto superior direito do quadro (**Visualização do gráfico**) muda a forma de desenhar os
  mesmos dados. Ele só oferece as visualizações que os dados comportam: **Barras**, **Linhas** e **Área**,
  **Pizza** quando há uma única série de valores não negativos e **Tabela** sempre. **Tabela** é uma aba
  com as mesmas linhas do gráfico. Trocar para outra visualização e voltar não perde nada.
- Leitores de tela leem o título do gráfico, as séries e o número de
  categorias.
- Além de gráficos de barras, linhas, área e pizza, uma resposta pode mostrar
  quatro visões de análise. Peça com as suas palavras ("quebre a receita por
  região e canal", "como o ticket médio se distribui?"):
  - **Tabela dinâmica**: uma dimensão nas linhas, outra nas colunas, a soma
    de uma medida em cada célula, com totais de linha, de coluna e geral. Uma
    combinação vazia mostra um traço, não um zero.
  - **Mapa de calor**: a mesma grade, cada célula sombreada do claro ao forte
    pelo seu valor, com o valor escrito na célula e uma legenda de baixo para
    alto. Uma célula vazia tem contorno tracejado e nenhuma cor.
  - **Dispersão**: duas medidas plotadas uma contra a outra, um ponto por
    linha. Os grupos usam uma cor diferente e um formato de marcador
    diferente, para que possam ser distinguidos sem depender da cor.
  - **Histograma**: como os valores de uma medida se distribuem, em barras
    adjacentes, uma por faixa.
- Quando você anexa uma planilha ou um CSV, ou uma ferramenta de dados como o
  Genie devolve linhas, o app prepara essas visões a partir das linhas reais.
  O assistente escolhe uma; ele não inventa os números. Mapas não estão
  disponíveis.
- Numa planilha gerada (.xlsx), os gráficos de dispersão e de histograma são
  gráficos nativos do Excel ligados às células, e o mapa de calor é uma escala
  de cores nas células de valor da tabela.

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
ferramenta aparece como uma etapa no cartão de etapas da resposta; um deck é montado slide a slide
enquanto a etapa roda, e o card do arquivo aparece onde a ferramenta foi chamada. Uma
atualização cria uma nova versão do arquivo: a resposta anterior mantém a
versão que mostrou. Um arquivo só passa a existir quando a resposta é salva: se
você interromper a resposta, nenhum arquivo dela fica. Uma ferramenta que falha
(por exemplo, atualizar um arquivo que o modelo não encontra) mostra uma etapa
com falha e a resposta continua.

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

## Estúdios

Os estúdios de deck, planilha e documento têm o mesmo layout: o que você aprende
em um vale para os outros.

### O painel do estúdio

Um estúdio abre como um painel ao lado da conversa. A largura segue a janela:

- **Acima de 1100 px** o painel fica ao lado do chat. O botão de artefatos na barra superior mostra ou
  oculta o painel.
- **De 768 a 1100 px** ele flutua sobre o chat como um diálogo, com o fundo escurecido; **Esc** ou um
  clique na área escurecida o fecham e o foco volta ao ponto em que estava.
- **Abaixo de 768 px** ele ocupa a tela inteira (veja Teclado e celular).

Todo estúdio tem o mesmo cabeçalho: o ícone do tipo, o nome com uma linha como **Apresentação · 3 slides**,
**Documento · 60 palavras** ou **Planilha · 2 abas**, e depois as ações: **Editar** (deck e documento),
**Compartilhar**, **Apresentar** (deck), **Exportar** e fechar. **Exportar** é o botão escuro.

### Editar com IA

Todo estúdio tem o mesmo painel **Editar com IA**: a escolha **Aplicar a**, uma
caixa para a instrução e **Aplicar** (ou ⌘/Ctrl+Enter). No Slide Studio a
mudança pode ir para **Este slide**, a **Seleção** (um elemento escolhido no modo
de edição) ou o **Deck inteiro**. No Spreadsheet Studio, para uma aba ou a pasta
inteira. Os painéis de deck e planilha também aceitam uma imagem de referência
(cole ou anexe), até 4. Uma edição por IA no Slides Studio cuja requisição passe de
46 MiB no total (notas do apresentador e imagens somadas) é recusada antes de ser
enviada, com uma mensagem que cita o limite: encurte uma nota ou remova uma imagem.
A edição da IA abre como prévia com **Aceitar e salvar** e
**Descartar**; nada é salvo até você aceitar.

### Salvamento

Os estúdios salvam sozinhos. O status ao lado das ferramentas do slide (deck) ou
no cabeçalho (planilha, documento) mostra **Salvando…** e depois **Salvo**. Se
uma gravação falha, aparece **Não foi possível salvar** com **Tentar de novo**, e
a sua alteração continua na tela até ser salva. Dois lugares só salvam quando
você pede: o modo **Editar** do deck (**Salvar** / **Descartar**) e o editor
manual do documento (**Salvar**). Sair de um deles com alterações não salvas
pede confirmação; nada mais pede.

### Duas abas no mesmo deck

Se o mesmo deck está aberto em duas abas (ou duas sessões) e uma delas salva, a
outra deixa de sobrescrevê-la em silêncio. O próximo salvamento da aba mais
antiga é recusado e o estúdio pergunta o que fazer: **Recarregar a versão
salva** (as edições não salvas desta aba são descartadas) ou **Manter a minha e
sobrescrever** (o deck desta aba substitui o outro, de propósito). Enquanto você
não escolhe, o estúdio não envia mais nada; **Tentar de novo** traz a pergunta de
volta. Uma edição com IA feita a partir de uma cópia antiga do deck faz a mesma
pergunta antes de gastar qualquer coisa. Se duas edições com IA do mesmo deck
começam ao mesmo tempo, só a primeira roda; a outra é avisada de que já há uma
edição com IA em andamento (nada é gasto e a sua instrução continua no campo) e
pode ser enviada de novo em instantes. Só o estúdio de slides faz isso;
planilhas e documentos continuam ficando com o último salvamento.

### Slides

- **Criando um deck.** Enquanto o modelo escreve o deck, o estúdio mostra
  **Criando o slide N de M** (ou **Criando o slide N…** quando o total ainda não
  é conhecido) e **Deck pronto · N slides** quando ele chega.
- **Excluindo um slide.** **Excluir slide** fica separado de **Adicionar** e
  **Duplicar**. Exclui na hora e oferece **Desfazer**. A oferta vale por 30
  minutos, inclusive depois de recarregar a página; o Desfazer devolve o slide
  ao lugar e salva o deck.
- **Modo de edição.** **Editar** abre o editor. À esquerda, duas abas: **Slides** (as miniaturas) e
  **Camadas** (a árvore de elementos do slide). Ao lado do slide, uma faixa vertical de ferramentas de
  desenho (selecionar, texto, formas, linha, seta, imagem). À direita, o painel **Design** com as
  propriedades do elemento selecionado. Um caminho acima das propriedades mostra onde o elemento
  selecionado está no slide (por exemplo *Slide › Grupo › Título*); clique em um passo para selecioná-lo.
  **Desfazer** e **Refazer** aparecem no cabeçalho durante a edição, com **Descartar** e **Salvar**.
- **Ações rápidas na seleção.** Ao selecionar um elemento, uma barra pequena aparece sobre o slide com
  **Ajustar com IA**, **Mais executivo**, **Encurtar** e **Traduzir**. **Ajustar com IA** e **Traduzir**
  põem **Aplicar a** em **Seleção** e levam você à caixa Editar com IA (**Traduzir** começa a frase
  "Traduza este elemento para " para você terminar com o idioma). **Mais executivo** e **Encurtar**
  enviam na hora um pedido pronto para aquele elemento. Como toda edição com IA, o resultado abre como
  prévia com **Aceitar e salvar** e **Descartar**.

### Planilhas

- O estúdio mostra a grade, uma barra de fórmulas acima dela (a caixa de nome com a célula ou o intervalo
  selecionado e a fórmula da célula ativa) e as abas das planilhas embaixo, com uma legenda das cores das
  células (**Entrada**, **Fórmula**, **Destaque**). A grade é somente leitura: os valores mudam pelo
  painel de IA, ou exportando o `.xlsx` e abrindo no Excel.
- **Ações de IA na seleção.** Selecione uma célula ou arraste um intervalo e uma barra pequena aparece ao
  lado: **Pedir à IA**, **Adicionar variação %**, **Gráfico da seleção** (só para um intervalo de várias
  células) e, quando a seleção tem uma fórmula, **Explicar fórmula**. A barra abre com as setas do teclado e **Esc** a fecha. Cada ação envia o
  mesmo tipo de edição por IA do painel, com o intervalo selecionado escrito no pedido, e o resultado abre
  como prévia para aceitar ou descartar.
- **Explicar fórmula** pede uma explicação em linguagem simples do que a fórmula calcula e a escreve como
  uma nota embaixo da tabela dela. Não muda nenhum valor, fórmula ou formato.

### Documentos

O documento abre numa página branca nos dois temas, como ficará no arquivo exportado. A barra de formatação
tem um menu **Estilo do texto** (parágrafo, títulos e assim por diante) com as marcas de sempre, listas e
tabelas. **Editar** passa para o editor manual. Não há sugestões, versões nem comentários.

### Exportar

Cada estúdio tem um único botão **Exportar** com os formatos que oferece:
PowerPoint com fontes universais ou da marca (deck), Excel (planilha) e Word,
Markdown ou PDF (documento). O menu funciona com as setas; Esc fecha.

### Teclado e celular

- **←** / **→** (e Page Up / Page Down, Home / End) trocam de slide, exceto
  enquanto você digita num campo ou move um elemento selecionado no slide.
- **Esc** funciona de dentro para fora: sai primeiro da caixa de texto, depois
  da seleção, depois do modo de edição (deck) ou do editor manual (documento).
  Só então fecha o estúdio de planilha ou de documento.
- No celular todo estúdio ocupa a tela. O botão no canto superior esquerdo diz
  **Voltar**, e o gesto de voltar do celular também sai do estúdio. Com
  alterações não salvas, ele pergunta antes de sair.
- Os botões dos estúdios têm no mínimo 32 px (40 px no celular), e os estúdios
  não animam quando o sistema pede movimento reduzido.

## Configurações

Abra as Configurações pela engrenagem na barra superior ou no rodapé da barra
lateral, ou com `/settings`. Elas abrem como um diálogo: o foco entra nele, Tab
e Shift+Tab ficam lá dentro, e Escape, o botão de fechar ou **Concluído** fecham
o diálogo e devolvem o foco ao botão que o abriu.

### Seções

A navegação à esquerda tem dois grupos:

| Grupo | Seções | Quem vê |
|---|---|---|
| Sua conta | Preferências, Conexões MCP, Skills, Design system | todos |
| Administração (com o selo **Admin**) | Modelos (LLM), Ferramentas, Administradores, Agentes | admins |

- **Preferências** reúne, de cima para baixo: **Aparência** (**Sistema**, **Claro** ou **Escuro**), o
  idioma da interface e da resposta, as notificações, a **Memória**, o tom da resposta e o prompt de
  sistema, os **Padrões para novas conversas** e o modelo de imagem.
  - **Padrões para novas conversas**: o **Modelo** com que uma nova conversa começa, as **Ferramentas**
    com que ela começa (um resumo somente leitura: a sua organização decide quais ferramentas existem, e
    você as muda por conversa na caixa de mensagem) e a **Leitura em voz alta**, a velocidade da voz que
    lê as respostas (**Ouvir um exemplo** deixa você escutar). O modelo de imagem já vem no recomendado da
    organização.
- **Design system** mostra o design system ativo e permite importar, editar, duplicar e excluir os seus.
  Os admins também podem publicar um como padrão da organização (veja abaixo).
- **Ferramentas** liga ou desliga grupos de ferramentas para a organização. Tem duas listas: **Ligadas por
  padrão** (Genie One, Gerador de Imagem, Python, Busca na Web, Memória, MCP Apps) e **Catálogos para
  escolher em cada conversa** (Genie Agents, funções do Unity Catalog, Vector Search, MCP). Abaixo delas, o
  **Catálogo MCP** gerencia os serviços MCP aos quais os usuários podem se conectar.
- No celular, dois botões no topo escolhem **Pessoal** ou **Organização**, e as seções dessa área rolam
  para o lado logo abaixo.

### Salvamento e erros

- Os controles de liga/desliga são chaves que leitores de tela anunciam com o estado.
- Cada rótulo fica acima do seu campo. Um valor que não pode ser salvo, como um
  preço negativo, é marcado no campo com o motivo, e nada é salvo até ser
  corrigido.
- Depois que uma mudança é salva, **Salvo** aparece ao lado dela. Quando o
  salvamento falha, o erro fica ao lado da mudança até a próxima tentativa.

### Modelos (admin)

**Modelos (LLM)** é uma tabela com uma linha por modelo: a marca do provedor, o nome (selecione a seta
para abrir o nome de exibição, a descrição e os preços), o id do endpoint, o **Preço** e uma chave **Ativo**.

- A coluna **Preço** diz de onde vem o preço: **Tabela curada** (o preço de tabela curado que vem com o
  app, atualizado com ele) ou **Negociado** (você preencheu o seu). Deixe os campos de preço em branco para
  usar o preço de tabela.
- **Ativo** substitui o antigo botão de remover. Desligar um modelo o tira do seletor de todos; a linha
  continua na lista, então ligá-lo de novo desfaz a ação.
- As setas reordenam os modelos. O primeiro é o padrão das novas conversas. **Adicionar modelo** inclui um
  endpoint que ainda não está no catálogo; é preciso informar o custo de entrada e de saída por milhão de
  tokens.

### Design system

**Design system** tem um seletor com os design systems que você pode usar, com ações para visualizar,
editar, duplicar, publicar para toda a organização e excluir. Abaixo, três abas mostram o que o design
system carrega:

- **Marca**: importe uma pasta ou arquivos soltos (`.pptx`, `.json`, fontes, logos, ícones e imagens),
  comece um novo template, baixe o kit inicial e veja as cores e as fontes extraídas.
- **Ativos**: o logo e os ícones que o AI Prism reaproveita antes de criar novos. Uma imagem que se repete
  em quase todo slide do arquivo de origem é detectada como marca d'água e nunca entra nos decks gerados;
  **Revisar** permite conferi-la.
- **Gráficos**: as cores de série das quais os gráficos de decks, documentos e planilhas tiram suas
  séries, nesta ordem. Um design system sem nenhuma cai na paleta neutra do AI Prism.

Nada foi removido da tela anterior: reordenar, editar, duplicar, publicar para a organização, excluir,
importar pasta ou arquivos e baixar o kit continuam todos lá.

### Acesso e políticas (admin)

A seção **Administradores** é a página **Acesso e políticas**. Ela lista os administradores (o proprietário
é sempre um) como etiquetas no campo em que você adiciona mais, e tem uma lista **Políticas** com links
para a documentação de guardrails do AI Gateway e para a documentação de orçamentos do Databricks.
Guardrails e limites de gasto são configurados lá, não no AI Prism. Só usuários ou grupos que já têm acesso
ao app no Databricks Apps podem ser promovidos a admin.

## Projetos

Um projeto reúne conversas, instruções e arquivos de referência, e pode ser
compartilhado com pessoas e grupos do workspace. Esta seção cobre as telas e as
regras que elas seguem.

### Usar projetos no app

- **Abra** em **Projetos**, na barra lateral (ou `#/projects`). Digite um nome e
  escolha **Criar projeto**. Cada projeto abre em uma página com quatro regiões:
  Conversas na coluna principal, e Instruções, Arquivos e Membros na coluna ao
  lado. No topo, uma trilha (**Projetos / nome**) leva de volta à lista.
- **Cor.** Todo projeto recebe uma cor, escolhida a partir do id dele. Você vê o mesmo pontinho colorido
  na página do projeto, na barra lateral e no seletor de projeto da tela Início; ela não muda quando você
  renomeia o projeto.
- **Compartilhar projeto** (no alto à direita da página) leva ao formulário de Membros. Os avatares dos
  membros aparecem sob o nome do projeto.
- **Renomear ou apagar** fica no topo da página do projeto. Apagar pergunta uma
  vez e avisa que o projeto, seus arquivos e todas as conversas dele são apagados
  junto, para todos. Só donos veem **Apagar projeto**.
- **Instruções** são salvas com **Salvar**. Um contador mostra quantos caracteres
  você usou do limite do servidor, e **Salvar** fica desligado enquanto o texto
  passar dele.
- **Arquivos**: **Enviar arquivos** adiciona documentos. Cada arquivo mostra se as
  conversas o leem (**No contexto**, **Parcialmente no contexto** ou **Fora do
  contexto (acima do orçamento)**), seu tamanho em tokens e um aviso quando o
  texto foi cortado no envio. Um arquivo grande demais ou de tipo não suportado é
  recusado antes de ser enviado, com o motivo e o que fazer.
- **Membros**: escolha Pessoa ou Grupo, digite o e-mail ou o nome do grupo,
  escolha um papel e **Adicionar**. A lista de papéis em cada linha muda o papel;
  a lixeira remove o membro. Um visualizador vê a lista sem esses controles e
  pode **Sair do projeto**.
- **Conversas**: a barra **Nova conversa neste projeto** acima das conversas, ou o **+** ao lado do
  projeto na barra lateral, inicia uma conversa dentro do projeto; escolher o projeto na tela Início também. A barra
  lateral lista as conversas de um projeto sob o nome dele. Para colocar uma
  conversa sua em um projeto, use o botão de pasta na linha dela. Conversas
  temporárias não podem estar em um projeto e não têm esse botão.
- **Em uma conversa de projeto**, cada mensagem dos colegas mostra quem a enviou,
  e uma linha sob a barra superior diz "<nome> está respondendo…" enquanto a
  resposta de outra pessoa está sendo escrita. Um visualizador não edita um
  prompt enviado nem regenera uma resposta.
- **Quando algo é recusado**, a mensagem diz qual papel você precisa e o que
  fazer, por exemplo pedir a um dono do projeto que mude seu papel. A página então
  lê o projeto de novo, e os controles que você não pode mais usar somem.
- As conversas de um projeto são mantidas até o projeto ser apagado; o período de
  retenção da organização não vale para elas.

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
- Apresentações, planilhas, documentos e imagens que alguém gerou em um chat do
  projeto aparecem para todos os membros, somente leitura: você pode abri-los e
  exportá-los, mas só quem gerou o artefato o edita (salvar, ou pedir à IA que o
  altere, responde "somente leitura"). Para mudar o trabalho de outra pessoa,
  peça uma nova versão ao assistente em uma mensagem sua.
- Excluir um projeto exclui as conversas dele e as imagens geradas nelas.
- O período de retenção de conversas da organização não vale para conversas de
  projeto: elas ficam até serem excluídas ou o projeto ser excluído.

### Arquivos

Os arquivos de um projeto ficam guardados como texto (PDF, Word, PowerPoint, Excel
e formatos de texto, como os anexos do chat). Até 10 arquivos de 25 MB por envio, e
50 arquivos por projeto. Só os primeiros 50.000 caracteres de cada arquivo são
guardados, e a lista marca um arquivo que foi cortado.

### O que uma conversa de projeto lê

- Toda conversa num projeto parte das instruções do projeto, sempre lidas por
  inteiro, e dos arquivos dele. Todo membro vê o mesmo contexto, qualquer que seja
  o papel, e ninguém de fora do projeto recebe nada disso.
- Os arquivos são lidos na ordem em que foram adicionados, até um limite de
  tamanho por mensagem (32.000 tokens por padrão, definido pelo administrador). O
  primeiro arquivo que deixa de caber é lido em parte quando sobra espaço
  suficiente, e os demais não são lidos. O assistente é avisado de quais arquivos
  não leu, e por isso diz isso quando você pergunta sobre eles.
- A lista de arquivos mostra, para cada um, se as conversas o leem por inteiro, em
  parte ou de modo nenhum, para você saber no que as respostas podem se apoiar.
  Para caber mais, remova os arquivos de que não precisa mais ou divida um grande.
- Cada mensagem de uma conversa de projeto mostra quem a enviou.

## Memória

O AI Prism pode lembrar alguns fatos duradouros sobre você entre conversas,
como o formato de resposta que você prefere, seu cargo ou equipe e os
projetos em que você está trabalhando. Ele usa esses fatos para ajustar as
próximas respostas. A memória é sua: ninguém mais, nem os administradores,
consegue ler suas entradas.

### O que é lembrado

- Depois que uma resposta termina, um modelo pequeno e rápido lê **apenas a
  sua mensagem** e pode guardar até três fatos dela. Ele nunca lê a resposta,
  os resultados de ferramentas nem páginas da web. Ele só olha mensagens
  curtas que dizem algo sobre você; texto longo ou com cara de colado
  (citações, e-mails, código) é ignorado, e um fato que pareça instrução, link
  ou endereço nunca é guardado. Um turno interrompido ou com falha não guarda
  nada, e regenerar uma resposta não lê a mensagem de novo.
- Você também pode adicionar, editar e excluir entradas (até 200, cada uma
  com até 500 caracteres). **Esquecer tudo** apaga todas de uma vez.
- A cada turno, no máximo 10 das entradas atualizadas mais recentemente vão
  para o modelo, limitadas a cerca de 1.500 tokens. Elas vão marcadas como
  notas sobre você, não como instruções, então um texto dentro de uma entrada
  não consegue conduzir o assistente.
- Aprender um fato tem um custo pequeno, que aparece no seu consumo como
  **memory**.

### Temas sensíveis

Fatos sobre saúde, política, religião ou finanças pessoais nunca são
aprendidos automaticamente. Se você adicionar um, ele fica guardado, mas só é
usado depois que você ligar **Incluir temas sensíveis** naquela entrada. Mover a
entrada para outra categoria sensível desliga esse consentimento de novo.

### Gerenciar sua memória

Abra Configurações → Preferências → **Memória**. A memória vem ligada por
padrão, e a seção avisa isso, com uma nota curta sobre o que é lembrado. Cada
entrada mostra sua categoria; use o lápis para editar, a lixeira para excluir
e **Adicionar memória** para escrever uma você mesmo.

- **Incluir temas sensíveis** é uma caixa em cada entrada. As categorias de
  saúde, política, religião e finanças pessoais só podem ser escolhidas depois
  que ela está ligada naquela entrada, e só então a entrada é usada nas
  respostas.
- **Esquecer tudo** pergunta uma vez, em uma janela (Esc ou Cancelar mantém
  suas entradas), depois exclui todas e informa quantas foram excluídas.
- Se a entrada já foi excluída em outro lugar, se o mesmo fato já existe ou se
  você chegou ao limite de 200, o formulário continua aberto e diz o que fazer.

### Quando um administrador desliga a memória

Um administrador pode desligar a memória para toda a organização em
Configurações → Ferramentas, no botão **Memória**. Enquanto ela estiver desligada, nada é aprendido,
nada vai para o modelo e a lista não pode ser aberta nem editada. Você ainda
pode excluir suas entradas.
