<!-- i18n: source=docs/user-guide.md source-hash=23297dc32d7d7a3dd960f1871eb058030e3647ec status=current -->
# Guia do usuário do AI Prism

[English](../user-guide.md) · **Português (Brasil)** · [Español](../es/user-guide.md)

Como usar o AI Prism no dia a dia. Cada seção cobre uma área do app.

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
