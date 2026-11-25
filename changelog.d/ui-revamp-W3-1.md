### Changed

- **Guia do usuário e README descrevem a interface da versão 2.0.0.** O guia (`docs/user-guide.md`, com as cópias em
  pt-BR e es) foi atualizado nas seções que o redesenho mudou: a barra superior (título ou trilha, Compartilhar, selo de
  custo, painel de artefatos) e a nova seção "Compartilhar uma conversa"; a barra lateral com o gasto do mês, os pontos de
  cor dos projetos, o tema e o trilho; a tela inicial com os três cartões e as conversas recentes; os seletores de modelo,
  ferramentas e estilo de resposta dentro do compositor e os atalhos `/deck`, `/memo`, `/planilha`, `/imagem`, `/genie` e
  `/python`; o cartão de etapas das respostas; o seletor de visualização do gráfico com a aba Tabela (no lugar de "Ver
  dados"); os cartões de artefato; o painel dos estúdios, as ações rápidas na seleção do deck, as ações de IA e "Explicar
  fórmula" na planilha e o Compartilhar nos três estúdios; os padrões para novas conversas e a velocidade da leitura em voz
  alta; a tabela de modelos com as marcas dos provedores, as abas Marca, Ativos e Gráficos do design system e a página
  Acesso e políticas; e a cor dos projetos. Os seletores do cabeçalho, que não existem mais, saíram do texto.
- **Capturas de tela no README.** Os três README (`README.md`, `README.pt-BR.md`, `README.es.md`) ganham a seção
  "Screenshots" com imagens em `docs/screenshots/` (início, conversa em tema claro e escuro, Estúdio de Slides, Estúdio de
  Planilhas e dois quadros de 390 px), geradas contra o servidor de fixtures, sem dados reais. Os trechos do README sobre o
  taxímetro e os passos de ferramenta seguem a nova interface.

### Fixed

- **Verificação de i18n da documentação volta a passar.** A chave `models.remove` do glossário deixou de existir com a
  tabela de modelos nova (o botão de remover virou a chave "Ativo"); o glossário agora cita `models.col.active`, e ganha
  `shell.share`, `chart.view.table` e `sheetStudio.quick.explain`.
