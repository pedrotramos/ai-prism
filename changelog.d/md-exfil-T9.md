### Added

- **Aviso de referências externas ao importar um kit de design system.** Ao importar um `.zip` ou pasta, o
  Relatório da importação passa a listar, por host e tipo, o conteúdo externo que o kit mantém (`<link>` ou
  `@import` do Google Fonts, fontes e imagens de CDN em `url()`, `<img src="https://…">`), explica que ele é
  bloqueado para evitar vazamento de dados e orienta a colocar os arquivos dentro do `.zip`. O aviso não
  bloqueia a importação e nada do que é guardado muda. O guia do usuário (en, pt-BR, es) ganhou a seção
  correspondente. Os scripts locais dos cartões (arquivo ou inline) também entram: toda URL http(s) em literal de texto vira uma referência "outro", uma vez por host e arquivo (pode haver falso positivo; preferimos isso a perder um carregador). O inspetor de templates já importados não mostra a lista: o HTML guardado já perdeu os
  `<link>` e `<script>` externos, então recalculá-la ficaria incompleta.
