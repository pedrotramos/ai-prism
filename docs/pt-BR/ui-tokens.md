<!-- i18n: source=docs/ui-tokens.md source-hash=8e4b6d168a791fd07f09545c10be1bfbbc85b879 status=current -->
# Tokens de design da UI

[English](../ui-tokens.md) · **Português (Brasil)** · [Español](../es/ui-tokens.md)

O cliente tem uma única camada de tokens: [`client/src/styles/tokens.css`](../../client/src/styles/tokens.css).
Toda cor, tamanho de texto, passo de espaçamento, raio, sombra, camada de z-index e
duração de movimento de que a UI precisa é uma propriedade CSS personalizada ali,
definida para os temas escuro (padrão) e claro. O [`tailwind.config.js`](../../tailwind.config.js)
mapeia cada uma para uma chave do Tailwind, então `text-faint`, `bg-accent-strong`,
`rounded-card`, `z-modal` e `duration-fast` resolvem para as mesmas variáveis e
acompanham o tema.

Por que isso importa na prática:

- **A acessibilidade é resolvida uma vez.** O contraste vive nos valores dos tokens;
  assim, um componente que usa `--faint` ou `--accent-strong` passa no WCAG AA sem
  código de cor próprio. Antes desta camada, o axe encontrava de 126 a 130 falhas de
  `color-contrast` (a contagem depende dos dados semeados) em 16 execuções: as quatro
  telas principais (boas-vindas, chat, Configurações, Deck Studio) nos dois temas, a
  1440 px e 390 px. Com a camada, as mesmas execuções reportam 0.
- **Mudar de tema mexe em um arquivo.** Claro e escuro diferem só em `tokens.css`.
  Nenhum componente precisa de uma variante `dark:` para cor.
- **Regressões quebram um teste, não uma revisão.**
  [`client/src/styles/tokens.test.js`](../../client/src/styles/tokens.test.js)
  recalcula toda razão abaixo a partir dos valores dos tokens a cada execução de
  `node --test`.
  [`client/src/styles/tokens.browser.test.js`](../../client/src/styles/tokens.browser.test.js)
  compila a folha de estilo a partir do código-fonte com a configuração do Vite do
  projeto (em memória) e a carrega no Chrome headless. Ele confere o anel de foco
  calculado em controles com `outline-none`, o movimento reduzido e as pontes de
  tokens nos dois temas. Ele precisa de:
  - Node >= 22, pelo `WebSocket` embutido que conduz o Chrome pelo protocolo
    DevTools;
  - as devDependencies que o repositório já tem: `vite`, mais o pipeline
    `tailwindcss`, `postcss` e `autoprefixer` que ele carrega via
    `postcss.config.js` (instaladas por `npm ci --include=dev`);
  - um binário do Chrome ou Chromium, encontrado por `CHROME_PATH`, pelo cache de
    navegadores do Playwright ou pelos caminhos de instalação usuais.

  Ele não precisa de nenhum pacote de automação de navegador (nem Playwright nem
  Puppeteer) e não adiciona dependência. Sem um binário de navegador, ele é pulado e
  imprime o motivo.

## Como usar

| Escreva isto | Não isto | Por quê |
|---|---|---|
| `text-faint` ou `text-[var(--faint)]` | `text-gray-500`, `text-[#6b7480]` | Acompanha o tema e mantém o contraste AA. |
| `bg-accent-strong text-on-accent` para um botão preenchido | `bg-[var(--accent)] text-white` | Branco sobre `--accent` é 3,6:1 (escuro) e 4,3:1 (claro). |
| `text-accent-text` para texto pequeno na cor de destaque | `text-[var(--accent)]` em texto | `--accent` é para ícones, traços e marcas grandes. |
| `text-danger`, `bg-danger-soft` para erros | o destaque da marca, `text-red-400` | Erros e ações primárias não devem compartilhar uma cor. |
| `bg-disabled text-disabled-text` | `disabled:opacity-50` em um botão preenchido | Um destaque semitransparente parece um botão habilitado suave. |
| `text-caption`, `text-label`, `text-body` … | `text-[11px]`, `text-[10.5px]` | Seis tamanhos em vez de 17 deixam a hierarquia legível. |
| `gap-in-group` dentro de um grupo, `gap-between-groups` entre grupos | meios passos como `gap-1.5` ou `gap-2.5` escolhidos ao acaso | Proximidade: o que se relaciona fica perto, os grupos ficam separados. |
| `rounded-card`, `rounded-control`, `rounded-badge`, `rounded-pill` | `rounded-xl` em um card, `rounded-2xl` no seguinte | Coisas parecidas têm aparência parecida. |
| `z-modal`, `z-popover`, `z-toast` | `z-[75]`, `z-[130]` | Uma escala ordenada. Chega de adivinhar um número que vença. |
| `duration-fast`, `duration-base`, `duration-slow` | `transition` puro, sem duração | O movimento tem três velocidades, e todas param com movimento reduzido. |

Foco: todo elemento focável recebe o anel global
`outline: 2px solid var(--focus-ring); outline-offset: 2px` em `:focus-visible`,
inclusive elementos escritos com `outline-none`. Para desenhar outro indicador, use
utilitários `focus-visible:` (por exemplo `focus-visible:outline-offset-0` ou
`focus-visible:ring-2`); eles têm especificidade maior que a regra global.
Nunca use `focus-visible:outline-none` (nem `outline-0`, `ring-0`, `shadow-none`,
`…-transparent`) sem um anel, contorno, borda ou sombra `focus-visible:` igualmente
visível na mesma linha que nada nela cancele; o `a11yBudget.test.js` rejeita isso.

## Tokens de cor

| Token | Escuro | Claro | Uso |
|---|---|---|---|
| `--bg` | `#0b0d0f` | `#f7f8fa` | Fundo da página |
| `--surface` (Tailwind `surface`, `surface-1`) | `#111418` | `#ffffff` | Painéis, cards, barra lateral |
| `--surface-2` | `#161a1f` | `#f1f3f5` | Superfície elevada ou com hover |
| `--surface-3` | `#1c2127` | `#e9edf1` | Superfície mais alta, chips, campos |
| `--border` / `--border-soft` | `#272d35` / `#1e242b` | `#e2e6ea` / `#eef1f4` | Linhas e divisórias |
| `--text` (Tailwind `fg`) | `#e8eaed` | `#1a1f24` | Texto do corpo |
| `--muted` | `#98a2b3` | `#5c6670` | Texto secundário |
| `--faint` | `#858e9a` | `#626b75` | Texto terciário: metadados, rótulos de grupo, durações |
| `--accent` | `#ff3621` | `#e5341f` | Marca: ícones, traços, marcas de seleção |
| `--accent-strong` | `#cc2c18` | `#c42a17` | Fundo do botão de ação (CTA) preenchido |
| `--accent-soft` | `rgba(255,54,33,.12)` | `rgba(229,52,31,.1)` | Preenchimento de linha ou aba selecionada |
| `--accent-text` | `#ff5a46` | `#b8281a` | Texto pequeno na cor de destaque, também sobre `--accent-soft` |
| `--on-accent` | `#ffffff` | `#ffffff` | Rótulo sobre `--accent-strong` |
| `--bubble-user` | `#1e2630` | `#eef2f6` | Balão de mensagem do usuário |
| `--link` | `#5b9dff` | `#1d64d8` | Links no markdown renderizado |
| `--danger` / `--danger-soft` | `#f2555a` | `#c62a2f` | Erros, ações destrutivas |
| `--success` / `--success-soft` | `#3dd68c` | `#18794e` | Concluído, saudável |
| `--warning` / `--warning-soft` | `#f5a524` | `#9a5b00` | Pede atenção |
| `--info` / `--info-soft` | `#6ea8ff` | `#1d64d8` | Informação neutra |
| `--disabled-bg` / `--disabled-text` | `--surface-3` / `--faint` | `--surface-3` / `--faint` | Controles desabilitados |
| `--focus-ring` | `#6ea8ff` | `#1d64d8` | Contorno do foco do teclado |

As variantes `*-soft` são a cor base a 14% (escuro) ou 10% (claro) sobre transparente.
Use-as como preenchimento de badges ou banners, com a cor base como texto.

## Matriz de contraste

Razão de contraste WCAG 2.x de cada token de primeiro plano sobre cada superfície do
mesmo tema. O texto precisa de 4,5:1. Um indicador de foco precisa de 3:1. O mínimo de
cada linha está no piso ou acima dele.

**Escuro**

| Token | Valor | `--bg` | `--surface` | `--surface-2` | `--surface-3` | Piso |
|---|---|---|---|---|---|---|
| `--text` | `#e8eaed` | 16.15 | 15.32 | 14.50 | 13.44 | 4.5:1 |
| `--muted` | `#98a2b3` | 7.56 | 7.17 | 6.79 | 6.29 | 4.5:1 |
| `--faint` | `#858e9a` | 5.87 | 5.57 | 5.27 | 4.89 | 4.5:1 |
| `--accent-text` | `#ff5a46` | 6.31 | 5.98 | 5.66 | 5.25 | 4.5:1 |
| `--accent-text` sobre `--accent-soft` | | 5.74 | 5.40 | 5.11 | 4.72 | 4.5:1 |
| `--link` | `#5b9dff` | 7.15 | 6.78 | 6.42 | 5.95 | 4.5:1 |
| `--danger` | `#f2555a` | 5.77 | 5.47 | 5.18 | 4.80 | 4.5:1 |
| `--success` | `#3dd68c` | 10.38 | 9.85 | 9.32 | 8.64 | 4.5:1 |
| `--warning` | `#f5a524` | 9.54 | 9.05 | 8.56 | 7.94 | 4.5:1 |
| `--info` | `#6ea8ff` | 8.07 | 7.66 | 7.25 | 6.72 | 4.5:1 |
| `--focus-ring` | `#6ea8ff` | 8.07 | 7.66 | 7.25 | 6.72 | 3:1 |
| `--faint` _anterior_ | `#6b7480` | 4.11 | 3.90 | 3.69 | 3.42 | |
| texto `--accent` _anterior_ sobre `--accent-soft` | `#ff3621` | 4.90 | 4.60 | 4.36 | 4.02 | |

`--on-accent` sobre `--accent-strong` (`#cc2c18`): **5,33:1**, e 4,54:1 com
`hover:brightness-110`. Branco sobre `--accent` (`#ff3621`) era 3,62:1.

**Claro**

| Token | Valor | `--bg` | `--surface` | `--surface-2` | `--surface-3` | Piso |
|---|---|---|---|---|---|---|
| `--text` | `#1a1f24` | 15.62 | 16.60 | 14.92 | 14.11 | 4.5:1 |
| `--muted` | `#5c6670` | 5.51 | 5.85 | 5.26 | 4.97 | 4.5:1 |
| `--faint` | `#626b75` | 5.09 | 5.41 | 4.87 | 4.60 | 4.5:1 |
| `--accent-text` | `#b8281a` | 5.89 | 6.26 | 5.62 | 5.32 | 4.5:1 |
| `--accent-text` sobre `--accent-soft` | | 5.09 | 5.42 | 4.90 | 4.66 | 4.5:1 |
| `--link` | `#1d64d8` | 5.11 | 5.43 | 4.88 | 4.62 | 4.5:1 |
| `--danger` | `#c62a2f` | 5.24 | 5.57 | 5.00 | 4.73 | 4.5:1 |
| `--success` | `#18794e` | 5.09 | 5.41 | 4.86 | 4.60 | 4.5:1 |
| `--warning` | `#9a5b00` | 5.11 | 5.43 | 4.88 | 4.61 | 4.5:1 |
| `--info` | `#1d64d8` | 5.11 | 5.43 | 4.88 | 4.62 | 4.5:1 |
| `--focus-ring` | `#1d64d8` | 5.11 | 5.43 | 4.88 | 4.62 | 3:1 |
| `--faint` _anterior_ | `#8a939c` | 2.93 | 3.12 | 2.80 | 2.65 | |
| texto `--accent` _anterior_ sobre `--accent-soft` | `#e5341f` | 3.53 | 3.76 | 3.40 | 3.23 | |

`--on-accent` sobre `--accent-strong` (`#c42a17`): **5,69:1**, e 4,87:1 com
`hover:brightness-110`. Branco sobre `--accent` (`#e5341f`) era 4,34:1.

No modo claro, `--faint` e `--muted` ficam próximos: nenhum cinza mais claro chega a
4,5:1 sobre `--surface-3`. Expresse o nível terciário também com tamanho
(`text-caption`) ou peso, não só com cor.

## Escala tipográfica

| Tailwind | Tamanho / altura de linha | Uso |
|---|---|---|
| `text-caption` | 11 / 16 px | Metadados, horários, rótulos de grupo da barra lateral |
| `text-label` | 12 / 16 px | Controles, chips, células de tabela |
| `text-body` | 14 / 20 px | Texto padrão da UI |
| `text-title` | 16 / 24 px | Títulos de cards e painéis |
| `text-heading` | 20 / 28 px | Títulos de página e de modal |
| `text-display` | 28 / 36 px | Hero de boas-vindas |

A prosa do chat (`.prose-chat`, 0.95rem) e a prosa de documentos (`.prose-doc`)
mantêm seus próprios tamanhos de leitura.

Regras: escreva só estas seis classes. Não use `text-xs`, `text-sm`, `text-base`,
`text-lg`, `text-xl`, `text-2xl` nem `text-[Npx]`. Mapeamento ao migrar: `xs` →
`label`, `sm` → `body`, `base`/`lg` → `title`, `xl`/`2xl` → `heading`,
`[9px]`…`[11px]` → `caption`, `[15px]`/`[0.95rem]` → `body`. O texto do corpo nunca
fica abaixo de 14 px (`text-body`); 11 e 12 px são só para metadados e controles. O
`client/src/a11yBudget.test.js` falha acima de 6 classes de tamanho legadas distintas.

## Espaçamento, raio, sombra

| Token | Valor | Tailwind |
|---|---|---|
| `--space-1` … `--space-8` | 4, 8, 12, 16, 24, 32 px | Os passos padrão do Tailwind `1 2 3 4 6 8` já coincidem |
| `--space-in-group` | 8 px | `gap-in-group`, `p-in-group` |
| `--space-between-groups` | 24 px | `gap-between-groups`, `mt-between-groups` |
| `--space-section` | 32 px | `gap-section`, `py-section` |
| `--radius-card` | 12 px | `rounded-card` (cards, painéis, modais) |
| `--radius-control` | 8 px | `rounded-control` (botões, campos) |
| `--radius-badge` | 6 px | `rounded-badge` (badges, chips pequenos) |
| `--radius-pill` | 9999 px | `rounded-pill` (toggles, pílulas, avatares) |
| `--shadow-raised` | pequena, próxima | `shadow-raised` (cards que sobem no hover) |
| `--shadow-overlay` | média | `shadow-overlay` (popovers, menus, toasts) |
| `--shadow-modal` | grande | `shadow-modal` (diálogos, studios) |

As sombras são mais escuras no tema escuro para continuarem visíveis em superfícies
quase pretas.

## Escala de z-index

Uma escala ordenada. A coluna da direita mapeia os valores arbitrários de hoje para o
token que um componente deve adotar na próxima vez que for editado.

| Token | Valor | Camada | Substitui hoje |
|---|---|---|---|
| `--z-raised` | 10 | Células fixas, irmãos sobrepostos | `z-10`, `z-[1]` |
| `--z-sticky` | 20 | Cabeçalhos fixos dentro de um painel | `z-20` |
| `--z-drawer` | 30 | Barra lateral, gaveta mobile | `z-30` |
| `--z-dropdown` | 40 | Cabeçalho do app e seus popovers | `z-40` |
| `--z-modal` | 50 | Configurações e diálogos de nível de app | `z-50` |
| `--z-modal-nested` | 60 | Diálogos abertos de dentro de um modal (diálogos de Skills) | `z-[60]` |
| `--z-studio` | 70 | Studios em tela cheia | `z-[70]`, `z-[80]` (Documento, Planilha) |
| `--z-editor` | 90 | Editores em tela cheia sobre modais e studios (inspetor de template) | `z-[90]` |
| `--z-popover` | 100 | Menus dentro de um studio | `z-[75]`/`z-[80]` (menu de exportação), `z-[130]` (menu de contexto) |
| `--z-fullscreen` | 120 | Modo de apresentação | `z-[120]` |
| `--z-dialog` | 140 | Confirmações | `z-[140]` |
| `--z-toast` | 200 | Notificações | `z-[60]` (toasts, que hoje ficam sob os studios) |

Valores arbitrários (`z-[75]`) não são permitidos: adicione um passo ao `tokens.css`
e ao `tailwind.config.js`. O teste de guarda falha em qualquer `z-[…]`.

## Anel de foco e alvos de toque

- **Anel de foco.** O foco do teclado é desenhado uma única vez, pela regra global
  `:focus-visible`. Um controle escrito com `outline-none` deve ter um anel, contorno,
  borda ou sombra `focus-visible:` na mesma linha de classes, ou abrir mão do
  `outline-none` (o anel global já se aplica). Um utilitário que remove ou esconde o
  indicador (`focus-visible:outline-none`, `outline-0`, `ring-0`, `shadow-none`, ou
  qualquer cor `…-transparent` / `/0`) não é um substituto, e ainda cancela um
  utilitário positivo do mesmo tipo na linha (`focus-visible:outline-2
  focus-visible:outline-transparent` não desenha nada). O marcador de importância
  (`!`) é ignorado na classificação, então `focus-visible:!outline-transparent`
  cancela do mesmo jeito. `outline-offset-*` sozinho não desenha nada. Confira o foco
  do teclado no navegador, não só o texto das classes. Quem usa o mouse continua sem
  ver anel em botões, porque `:focus-visible` não casa com os cliques.
- **Alvos de toque.** Todo botão, link e campo tem pelo menos 24 × 24 px (WCAG 2.2 AA
  2.5.8). Controles de cabeçalho e de barras de ferramentas têm pelo menos 44 px de
  altura em 390 px de largura: use `min-h-11 min-w-11` (ou `max-md:min-h-11`) e
  aumente as linhas densas do desktop só em telas pequenas, para as tabelas manterem
  o ritmo.

## Valores avulsos

Props de estilo, literais hex e `rgb()`, classes de paleta cruas (`bg-white`) e
tamanhos arbitrários (`w-[380px]`) contornam os tokens. Use primeiro um token ou um
utilitário padrão (`bg-scrim` para o fundo de diálogos, `text-on-accent`). Só dados
podem ficar: amostras de cor do design system, preenchimentos derivados do DS, a arte
do logo, tamanhos medidos em tempo de execução. Marque com `/* data */` na mesma linha
ou na anterior, ou envolva um bloco em `/* data:start */ … /* data:end */`. O teste de
guarda permite no máximo 60 valores sem marca.

## Movimento

| Token | Valor | Uso |
|---|---|---|
| `--duration-fast` | 150 ms | Hover, pressionar, mudanças de cor (`duration-fast`) |
| `--duration-base` | 200 ms | Painéis, gavetas, popovers (`duration-base`) |
| `--duration-slow` | 300 ms | Entradas em nível de página (`duration-slow`) |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | A maioria das transições (`ease-standard`) |
| `--ease-emphasized` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entradas (`ease-emphasized`) |

Quando o SO pede movimento reduzido (`prefers-reduced-motion: reduce`), o `index.css`
define `animation: none` e `transition: none` (com `!important`) em todo elemento e
pseudoelemento, além de `scroll-behavior: auto`. Fades, deslizes, shimmer, pulso,
bounce, spinners e o cursor de streaming param todos. O cursor continua visível, e as
animações de entrada não deixam conteúdo escondido. `animationend` e `transitionend`
**não** disparam nesse modo, então nunca faça o estado da UI depender deles; nada no
cliente depende hoje.

## Regras globais em `client/src/index.css`

Mudanças aqui e no `tokens.css` chegam aos usuários pelo `client/dist` compilado, que é
reconstruído em PRs de release, não em PRs de feature. Para ver uma mudança localmente,
use `npm run dev:local` (o Vite compila na hora).

- `@import './styles/tokens.css'` é a primeira instrução.
- `:focus-visible` desenha `2px solid var(--focus-ring)` com 2px de deslocamento. A
  regra não está em uma layer e vem depois de `@tailwind utilities`, então, com a
  mesma especificidade, vence o `outline-none` (todo controle que ainda o tem). Um
  utilitário `focus-visible:` continua sobrescrevendo-a.
- `prefers-reduced-motion: reduce` desliga o movimento, como descrito acima.
- **Pontes de tokens:** marcação escrita como `bg-[var(--accent)] text-white` recebe
  `--accent-strong` como fundo. Marcação escrita como `bg-[var(--accent-soft)]
  text-[var(--accent)]` recebe `--accent-text` como cor. Esses dois seletores fazem
  os botões e abas ativas existentes passarem no AA sem editar componentes. Apague
  cada ponte quando nenhum componente usar mais o seu par de classes.

## Tinta sobre uma cor do design system

Slides de deck, cabeçalhos de seção de planilha e as prévias de template colorem o
texto que fica sobre uma cor do design system (primária, de destaque, de fundo, uma
faixa de seção) com `contrastOn` em `shared/deckTheme.ts`. Ele compara a razão de
contraste WCAG 2.x do branco (`#FFFFFF`) e do quase preto (`#1A1A1A`) sobre essa cor e
devolve o maior; um empate exato devolve o quase preto. Ele não usa um limiar de
luminância, então uma cor de marca de tom médio recebe a tinta que lê melhor, em vez
de branco a 3,6:1. Quando qualquer das duas tintas chega a 4,5:1, a escolhida também
chega. `relativeLuminance` e `contrastRatio` são exportadas junto dela. Nenhuma cor do
tema muda: só a tinta escolhida sobre ela. A escolha do lockup do logo
(`pickLogoForBg`) continua usando a divisão grosseira claro/escuro de propósito.

## Obsoleto

- O `lava` do Tailwind é um alias obsoleto: resolve para `var(--accent)`, então o
  antigo `#FF3621` fixo some e a cor acompanha o tema. Ele só permanece nos três
  pontos de gradiente de `VoiceOverlay.jsx` (`from-lava`, `to-lava`), porque os
  arquivos de componente estavam fora do escopo da mudança de tokens. Será removido na
  tarefa da Wave 2 que migra `VoiceOverlay.jsx` para `from-accent` / `to-accent`; não
  adicione novos usos.
- A paleta `ink.*` e `lava.600`/`lava.700` foram removidas: não tinham usos.
