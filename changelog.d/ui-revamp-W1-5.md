### Changed

- **Painel dos estúdios e editor de apresentações no novo desenho.** O cabeçalho do painel agora mostra o ícone do tipo,
  o nome com a linha "Apresentação · N slides", desfazer e refazer (no deck, durante a edição), o botão de exportar
  em tinta (`--action`/`--on-action`) e fechar. A largura do painel passa a vir de `--panel-w` (`min(46vw, 760px)`,
  mínimo de 420 px); até 1100 px ele flutua sobre o chat como diálogo, com laço de foco, e abaixo de 768 px ocupa a
  tela inteira. No editor do deck, a barra de ferramentas vira uma trilha vertical ao lado da tela, a coluna da esquerda
  ganha as abas Slides e Camadas (navegáveis por teclado, com a árvore de elementos acessível por teclado) e a coluna da
  direita vira o painel Design. Ao selecionar um elemento, uma barra rápida oferece "Ajustar com IA", "Mais executivo",
  "Encurtar" e "Traduzir" sobre a IA de escopo de elemento que já existia, com a prévia Aceitar/Descartar de sempre. Os
  slides continuam renderizando pelo design system carregado, sem tokens do aplicativo. Sem seletor de versões,
  comentários nem presença, e sem botão de compartilhar no painel.
