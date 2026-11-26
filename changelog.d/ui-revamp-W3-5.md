### Changed

- **Editor de slides: painel Design no nível do slide e foco visível na prévia.** Com nenhum elemento selecionado, o painel
  Design agora mostra a seção "Slide N": fundo com as cores do design system ativo, margens do slide (superior, direita,
  inferior, esquerda) e uma grade (colunas e espaçamento) que é só uma guia do editor, desligada por padrão, e nunca é
  salva nem exportada. Fundo e margens passam pela mesma operação de edição dos elementos, então desfazer/refazer,
  Salvar/Descartar e a exportação .pptx os levam junto. A prévia do slide, que é uma parada do teclado, passa a mostrar o
  anel de foco padrão do aplicativo.

### Fixed

- **Margens do slide: editar um lado não reescreve os outros.** Antes, editar só o "Superior" de um slide com
  `padding: 2rem 3rem 4rem 5rem` gravava os quatro lados em px lendo `3rem` como 3. Agora só o lado editado é gravado (o
  próprio `padding-top` etc.) e os outros mantêm o CSS original (rem, em, %, `calc()`). Os campos mostram o valor como foi
  escrito, e um número sem unidade vale px.
