### Changed

- **Nova casca do aplicativo: barra lateral, barra superior, histórico e avisos.** A barra lateral passa a 256 px, com a
  marca, "Nova conversa", a busca, os atalhos e as conversas em grupos de tempo; cada projeto ganha um ponto de cor
  derivado do seu id (oito tokens `--project-0` a `--project-7`, `lib/projectColor.ts`). No rodapé, todo usuário vê o
  próprio gasto do mês (a mesma fonte do taxímetro, `/api/usage/summary`), o nome, o botão de tema claro/escuro e as
  configurações. Recolhida, ou com a janela até 1100 px, a barra vira um trilho de 64 px; passar o mouse ou focar o
  trilho abre a barra completa por cima do conteúdo (Esc fecha), e até 760 px ela é uma gaveta. A barra superior (54 px)
  deixa de mostrar os seletores de modelo e de ferramentas (eles vão para o compositor), aceita trilha de navegação,
  alternância do painel de artefatos e ações, e o taxímetro vira um selo com o gasto da conversa que abre o mesmo
  detalhamento de antes. Os avisos viram uma pílula de tinta no rodapé, com ação opcional. Os botões primários do
  histórico passam a usar a tinta (`--action`).
  O painel que a barra lateral abre ao passar o mouse no trilho fica invisível (não mais `inert`) enquanto recolhido, e a
  sobreposição de voz mostra a marca e o nome do modelo da conversa ativa.
  O cartão de gasto do mês na barra lateral agora mostra o erro (com "Tentar de novo") e, se já havia um valor, o mantém
  marcado como desatualizado; só a resposta mais recente é aplicada, então uma resposta lenta e antiga não sobrescreve o
  total novo. O ícone de ferramentas do compositor deixa de ser uma imagem vermelha e passa a usar a cor do texto do
  tema, e o selo de custo no celular anuncia o gasto da conversa ativa, como no desktop.
