### Changed

- **Nova identidade visual: acento índigo, botões primários em tinta e IBM Plex.** A camada de tokens
  (`client/src/styles/tokens.css`) troca a paleta vermelha por índigo nos dois temas, com os papéis novos `--raised`,
  `--action`/`--on-action`, `--code-bg`, `--chart-neg` e o gradiente `--spectrum`, a escala de texto de sete passos (mínimo
  12 px, com `reading` 15,5/26) e os raios e tempos de movimento do novo desenho. Os nomes dos papéis não mudam, então
  nenhum componente muda. Quatro cores do desenho foram escurecidas para atingir contraste AA (`--faint` nos dois temas,
  `--warning` e `--success` no claro). A fonte passa a ser IBM Plex Sans, Serif e Mono, empacotada com o aplicativo
  (pacotes `@fontsource`): não há mais chamada ao Google Fonts. A marca do prisma e o favicon foram redesenhados. O tema
  padrão agora segue o sistema (`system`); quem já escolheu claro ou escuro mantém a escolha. Um teste novo
  (`dsIsolation.test.ts`) garante que slides, documentos, planilhas e prévias do design system não leem tokens do
  aplicativo.
