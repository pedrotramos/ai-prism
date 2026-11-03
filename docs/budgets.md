# Budgets mensais

Admins podem limitar quanto cada pessoa gasta por mês no AI Prism. O consumo é
medido pelo [taxímetro](../README.md#taxímetro-de-custos), o mesmo contador que
cada usuário vê no header. Assim, quem tem um budget acompanha quanto já usou e
não é pego de surpresa.

Budgets são **opcionais**. Desligados (o padrão), o taxímetro continua mostrando
o gasto, mas ninguém tem limite.

---

## Como configurar

Em *Configurações → Budgets* (aba de admin):

1. Marque **Habilitar budgets mensais**.
2. Defina o **budget padrão** (US$ por mês). Com budgets ligados ele é
   obrigatório e vale para quem não tem nenhuma regra própria.
3. Escolha o que acontece **ao atingir o budget**:
   - **Só avisar**: o taxímetro fica vermelho e a pessoa recebe um aviso, mas o
     uso continua liberado.
   - **Bloquear**: novos pedidos (mensagens no chat, *Gerar resposta*,
     *Regenerar* e edições por IA nos estúdios) são recusados até a virada do mês
     ou até o budget subir. O pedido que já estava em andamento termina.
4. Ajuste o **limiar de aviso** (padrão: 80%). A partir dele o taxímetro fica
   âmbar e a pessoa recebe um aviso, uma vez por mês.
5. Escolha o **fuso horário da virada do mês** (padrão: UTC). Ele define quando o
   budget renova e também quando o total mensal do taxímetro zera.
6. Clique em **Salvar**.

### Regras por usuário e por grupo

Abaixo das configurações, adicione regras que sobrescrevem o padrão:

- **Usuário**: o e-mail da pessoa.
- **Grupo**: o nome de um grupo do workspace. A regra define o budget de **cada
  membro** do grupo (não é um teto compartilhado pelo grupo).

O campo sugere usuários e grupos que já têm acesso à App. O valor de uma regra
pode ser editado no próprio campo e é salvo ao sair dele.

---

## Qual budget vale para cada pessoa

1. Se **nenhuma regra** se aplica à pessoa, vale o **budget padrão**.
2. Se uma ou mais regras se aplicam (a dela e as dos grupos de que ela faz
   parte), vale a **regra de maior valor**. O padrão deixa de valer para essa
   pessoa, mesmo que seja maior que as regras dela.

| Pessoa | Regras que se aplicam | Budget efetivo |
|---|---|---|
| Paulo Machado, do grupo `eng_dados` | `eng_dados` = US$ 200 · `paulo.machado@…` = US$ 500 | **US$ 500** (a maior regra) |
| Ana, dos grupos `eng_dados` e `diretoria` | `eng_dados` = US$ 200 · `diretoria` = US$ 1.000 | **US$ 1.000** |
| Bia, do grupo `estagiarios` (padrão = US$ 100) | `estagiarios` = US$ 20 | **US$ 20** (a regra substitui o padrão) |
| Carlos, sem regra | nenhuma | **US$ 100** (o padrão) |

Um budget de US$ 0 numa regra significa "sem uso": no modo *Bloquear*, a pessoa
não consegue enviar pedidos.

---

## O que o usuário vê

- No header, o taxímetro passa a mostrar `Mês $12,30 / $200`, e o ícone do chip
  dá lugar a um **anel de progresso** com o percentual consumido — na cor da
  marca abaixo do limiar de aviso, âmbar a partir dele e vermelho ao atingir o
  budget.
- Clicando no taxímetro: porcentagem usada, quanto resta, de onde vem o budget
  (padrão da organização, definido para você ou do grupo X), o modo e a data em
  que renova.
- Um aviso único por mês ao cruzar o limiar e outro ao atingir o budget.
- No modo *Bloquear*, um aviso fixo acima do campo de mensagem explica o
  bloqueio e quando o uso volta. Se o servidor recusa um pedido, a resposta é
  HTTP `402` com `code: "budget_exceeded"` e a mensagem no idioma da pessoa.

## Visibilidade do taxímetro

Na mesma aba, em *O que os usuários veem no taxímetro*, o admin decide o que
aparece para **todos** (admins inclusive; o consumo de cada pessoa continua na
tabela abaixo):

| Opção | Efeito |
|---|---|
| **Mostrar o custo da sessão** (padrão: ligado) | Desligado, some o custo da conversa no taxímetro **e** os custos por chamada: rodapé das mensagens (`~$0,01`), imagem gerada, mídia, roteador de intenção e edições por IA nos estúdios. As contagens de tokens continuam. |
| **Custo do mês: em USD** (padrão) | `Mês $12,30 / $200`, quanto resta e o detalhe do budget. |
| **Custo do mês: em % do budget** | `Mês 42%` com o anel de progresso; no detalhe, só o percentual, a origem do budget, o modo e a data de renovação — nenhum valor em dólar. **Exige budgets ligados**: desligá-los volta a opção para USD. |
| **Custo do mês: oculto** | Nada do mês aparece; o aviso de % não é mostrado. Um bloqueio por budget continua sendo avisado (sem valores). |

Se nada estiver visível (sessão desligada e mês oculto), o taxímetro some do
header. O corte é feito **no servidor**: `GET /api/usage/summary` devolve
`display: { session, month }` e omite os campos ocultos, então os valores não
chegam ao navegador. Fora do modo USD, a recusa `402 budget_exceeded` e o aviso
acima do campo de mensagem também saem sem valores.

## Consumo do mês (visão do admin)

A mesma aba lista o gasto de cada usuário no mês corrente, com o budget que se
aplica, a origem (padrão, regra de usuário ou grupo) e a porcentagem.

A participação de **outras pessoas** em grupos só pode ser lida com o token dela
(SCIM `/Me`). Por isso o app guarda o último budget calculado de cada usuário
(tabela `user_budget_snapshot`, atualizada quando o taxímetro dela carrega).
Quem ainda não abriu o app desde que os budgets foram configurados aparece com o
budget calculado só pela regra de usuário ou pelo padrão, marcado como *grupos
ainda não verificados*.

---

## Limitações e detalhes

- **Estimativa a preço de lista.** O consumo é o do taxímetro: cada chamada aos
  modelos, precificada pelo catálogo do app (preço de lista do fornecedor ou o
  preço que o admin definiu na aba *Modelos*). Descontos negociados não entram.
  O valor faturado continua no [dashboard de custos](../dashboards/README.md).
- **Cap suave.** A checagem acontece antes de cada pedido. Um pedido que começa
  abaixo do budget termina mesmo que o ultrapasse; o seguinte é recusado.
- **Depende do SCIM para grupos.** Se o app não consegue ler os grupos da pessoa
  (escopo IAM ausente na App), as regras de grupo não se aplicam. A pessoa cai na
  regra de usuário ou no padrão, e a aba de admin mostra um aviso.
- **Falha aberta.** Se o banco não responder na hora da checagem, o pedido
  segue (e o erro vai para o log). Uma instabilidade nunca bloqueia a
  organização inteira.
- **Admins não são isentos.** Um admin que atinge o próprio budget pode subi-lo
  na mesma aba.
- Tabelas no Lakebase: `app_budget_settings` (configuração, uma linha),
  `app_budget_rules` (regras) e `user_budget_snapshot`. O gasto vem do
  `usage_ledger` do taxímetro.
