### Fixed

- **Teste e2e do gráfico intermitente** (`client/e2e/message.spec.mjs`, "the chart has a text alternative
  and a View data table"): o Recharts remonta as barras a cada quadro da animação de entrada, e a leitura
  das cores em dois passos (localizar, depois ler) às vezes pegava nós já desanexados (cor `""`), falhando
  em `fills.length >= 2`. Agora a leitura acontece numa única tarefa do navegador e o teste espera, com
  `expect.poll`, as 2 séries × 4 barras pintadas em 2 cores antes de checar que o vermelho da marca não
  aparece. Só o teste muda; o componente já estava correto (0 remontagens depois que o gráfico assenta).
