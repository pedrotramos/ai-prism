### Fixed

- **Ajustes de acessibilidade, custo e cache antes da 2.0.0.** O popover de ferramentas do compositor agora limita a altura
  ao espaço acima do botão e abre para baixo quando falta espaço, então o foco do teclado nunca sai da tela em janelas
  baixas. Ao abrir um estúdio (apresentação, planilha ou documento) pelo teclado, o foco vai para o painel do estúdio e,
  ao fechar, volta ao cartão que o abriu. Todos os `placeholder` agora usam a cor `--faint` (contraste mínimo de 4,5:1 nos
  dois temas). O texto de custo usa um só termo nos três idiomas, "estimativa a preço de lista", e diz que descontos
  negociados não estão incluídos. Os arquivos com hash em `/assets` passam a sair com `Cache-Control: public,
  max-age=31536000, immutable`, e o `index.html` com `no-cache`.
