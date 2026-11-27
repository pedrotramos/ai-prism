<!-- i18n: source=docs/agents.md source-hash=565c9f1d8e803b9e61b49ac854301d5f2e048f12 status=current -->
# Agentes agendados

[English](../agents.md) · **Português (Brasil)** · [Español](../es/agents.md)

Um agente agendado é um prompt salvo que o AI Prism executa sozinho, num horário definido, sem ninguém no teclado.
Cada execução cria um novo chat no histórico do dono, com a resposta e qualquer deck, planilha ou documento que ela
tenha produzido.

A funcionalidade vem **desligada**. Esta página explica como quem uma execução sem supervisão age e a que dados ela
chega, porque essa é a decisão que o administrador toma ao aprovar um agente.

## Como ligar

Duas chaves, as duas são necessárias:

1. O operador define `AGENTS_ENABLED=1` no ambiente do app (`app.yaml`) e faz o redeploy. Sem isso as rotas
   respondem `404 agents_disabled`, nenhum agendador inicia e a interface fica oculta.
2. Um administrador liga os agentes em Configurações (a configuração `agents_enabled`). Enquanto ela estiver
   desligada, um agente ainda pode ser escrito e enviado para aprovação, mas não pode ser ativado e "executar agora"
   é recusado.

Para reverter, desligue a configuração (suave) e depois remova `AGENTS_ENABLED` e faça o redeploy (completo). Os dois
caminhos mantêm todas as definições e o histórico de execuções.

Os administradores também definem, no mesmo lugar:

| Configuração | Padrão | Faixa | Significado |
|---|---|---|---|
| `agents_max_run_cost_usd` | 1.0 | 0.05 – 50 | Uma execução que atinge esse custo para na próxima chamada ao modelo; a resposta até ali é mantida, com um aviso. |
| `agents_approval_days` | 90 | 1 – 365 | Quanto tempo dura uma aprovação. Depois disso o agente para e o dono precisa reenviá-lo. |

Toda mudança de configuração e toda decisão grava uma linha na auditoria de administração.

## Agendas

Um agente roda na agenda que você escolhe em **Repetir**: a cada hora, todo dia, dias úteis, toda semana ou todo mês,
com o horário (e o dia), um **fuso horário** e a prévia das **próximas três execuções**, calculadas pelo servidor
nesse fuso (um horário que não existe num dia de horário de verão roda no primeiro instante válido; um que acontece
duas vezes roda uma vez).

**Personalizado (avançado).** Para o que as cinco opções não dizem (duas vezes por dia, segunda-quarta-sexta, dias 1
e 15), escolha **Personalizado (avançado)** e digite um cron padrão de cinco campos:
`minuto hora dia-do-mês mês dia-da-semana`, com listas (`1,3,5`), intervalos (`1-5`), passos (`*/2`), nomes
`JAN-DEC` e `SUN-SAT` e os atalhos `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. Quando os dois campos de
dia são restritos, um dia vale se coincidir com qualquer um deles, como no cron de Vixie. O editor parte do cron da
opção que você tinha, mostra as próximas três execuções enquanto você digita e diz por que um cron é recusado:
número de campos errado, valor fora do intervalo, nenhuma data real (`0 0 31 2 *`) ou **mais de uma vez por hora**
(um agente nunca roda com mais frequência que a opção de hora em hora). Um cron que uma das cinco opções já cobre é
salvo como essa opção, então duas grafias de "toda segunda às 08:00" são uma só definição. O cron personalizado faz
parte do que o administrador aprova: editá-lo, ou o fuso horário, anula a aprovação como qualquer outra edição. Ele é
salvo numa grafia canônica única (`MON-FRI`, `mon-fri` e `1,2,3,4,5` são todos guardados como `1-5`, e `7` como `0`),
então as regravações comuns nunca mudam a aprovação (uma lista de dias que começa com `*` e não é um passo simples,
como `*/2,MON`, mantém a própria grafia: regravá-la conta como edição), e a tela de revisão mostra ao administrador o que ele
significa: a descrição e as próximas três execuções, com um aviso quando os dois campos de dia estão preenchidos
(`0 9 1,15 * 1` roda nos dias 1 e 15 **e** em toda segunda). Uma data rara, mas real, é aceita: `0 0 29 2 *` roda todo
29 de fevereiro e `0 0 29 2 */7` nos 29 de fevereiro que caem num domingo (2032, 2060, 2088).

**Horário de verão.** Um cron personalizado segue as mesmas regras das cinco opções: um horário local que não existe
naquele dia roda no primeiro instante válido depois da lacuna, e um que acontece duas vezes roda uma vez, na primeira
ocorrência. A regra "não mais de uma vez por hora" é conferida no relógio de parede, então no dia em que os relógios
avançam `30 1,2 * * *` roda às 03:00 pela segunda vez, 30 minutos depois da primeira (02:30 não existe). Não é uma
garantia de uma hora entre execuções nesse único dia; um agente continua nunca rodando duas vezes ao mesmo tempo.

### Como o agendador espera

O agendador não faz polling. Ele lê o banco, reivindica o que está vencido e então dorme até o primeiro entre a
próxima execução agendada, uma execução manual na fila e o fim do lease de uma execução em andamento. Ele também
consulta de novo no máximo a cada **6 horas** (`AI_PRISM_SCHEDULER_MAX_SLEEP_MS`, de 1 segundo a 24 horas; o nome
antigo `AGENT_SCHEDULER_MAX_SLEEP_MS` ainda é lido) e logo depois que o app inicia. Aprovar, ativar, desativar ou
excluir um agente e enfileirar uma execução o acordam na hora, no processo que atendeu a requisição. Entre esses
momentos ele não faz nenhuma consulta, então as conexões do app fecham (2 minutos ociosas) e o Lakebase pode escalar a
zero entre as execuções.

O que vale saber:

- Várias réplicas dividem o trabalho pelos mesmos locks de antes: um horário é reivindicado uma vez, qualquer que seja
  a réplica que acorde primeiro.
- Uma mudança feita numa réplica chega às outras pelo uso do app. Enquanto alguém o usa, o banco já está acordado, então
  uma réplica que não olhou as agendas há 5 minutos olha de novo na próxima requisição autenticada. A garantia:
  enquanto o app está em uso, uma agenda salva numa réplica que depois para é vista por outra em cerca de 5 minutos,
  bem dentro da hora de tolerância, e o horário roda. Com o app ocioso nada acorda as outras réplicas antes da
  próxima execução delas, da conferência de 6 horas ou da inicialização, então um horário salvo logo antes de a última
  réplica que o conhecia parar pode ser reivindicado com atraso e, se passar de uma hora, registrado como `missed`.
  Uma mudança feita enquanto a própria réplica está ocupada nunca se perde: se um administrador ativa os agentes
  enquanto ela lê a configuração, ela planeja de novo a partir do banco em vez de dormir sobre uma resposta velha.
- Uma execução cujo horário passou sem nenhuma réplica acordada (o app estava parado) é reivindicada com atraso se
  tiver menos de uma hora e, caso contrário, é registrada como **ignorada** com o código `missed`. Execuções perdidas
  nunca são refeitas: o próximo horário conta a partir de agora.
- Uma linha de execução pode ficar `running` depois que o app morreu até o lease (120 s) expirar **e** uma réplica
  acordar (em cerca de 5 minutos com o app em uso, até o sono máximo quando ocioso); reduza
  `AI_PRISM_SCHEDULER_MAX_SLEEP_MS` se isso importar mais que o tempo ocioso do Lakebase.

## Ciclo de vida de um agente

1. O dono escreve o agente (instruções, prompt, modelo, ferramentas, agenda opcional) e o salva como **rascunho**.
   Cada dono pode ter 10 agentes.
2. O dono **envia** o agente. Ele passa a **pendente**.
3. Um administrador revisa a definição e **aprova**, **rejeita** (com um motivo) ou, depois, **revoga**. A tela envia
   o hash da definição que mostrou; se o dono editou o agente nesse meio-tempo, a aprovação é recusada com `409` e
   nada é gravado, de modo que o administrador nunca aprova algo que não leu.
4. O dono **ativa** a agenda. Isso é recusado a menos que o agente esteja aprovado, a aprovação não tenha expirado e
   a configuração esteja ligada. Ativar calcula o próximo horário de execução a partir da agenda e do fuso horário.
5. **Executar agora** enfileira uma execução manual de um agente aprovado. Enquanto uma execução estiver na fila ou em
   andamento, outra é recusada com `409 busy`.

**Qualquer edição do que o administrador aprovou anula a aprovação.** O próprio banco de dados devolve o agente a
rascunho e o desliga no mesmo comando, então nenhuma rota pode esquecer. Só o nome e a descrição mudam sem nova
aprovação. Uma execução sempre roda o snapshot aprovado, nunca a linha em edição, e confere no início que a aprovação
ainda é válida.

## Como quem uma execução sem supervisão age

| Parte da execução | Identidade |
|---|---|
| O gateway de modelos, cada ferramenta e cada chamada MCP | **O service principal do app**, não o dono |
| O chat, suas mensagens e artefatos, o registro de uso | O **dono**: as linhas são dele, como se ele tivesse enviado a mensagem |
| O registro de que a execução começou e terminou | Um ator de sistema na auditoria de administração (só códigos e ids, sem e-mail nem texto) |

A execução usa o service principal porque não há ninguém para entrar: o token do usuário só existe enquanto ele está
no app.

### O que ela pode fazer

- Criar um novo chat do dono, com o nome do agente e o horário da execução no título.
- Gravar as mensagens, as chamadas de ferramenta e os artefatos desse chat.
- Ler o template de deck e o modelo de imagem selecionados pelo dono.
- Chamar o modelo e as ferramentas que o administrador aprovou.

### O que ela não pode fazer

- Ler os outros chats do dono: a execução começa num chat novo e vazio, e a busca no histórico entre chats não é usada.
- Ler ou gravar as memórias do dono, nem usar o contexto de projetos.
- Usar qualquer credencial por usuário, como uma conexão MCP pessoal. Uma execução que precise de uma falha com
  `sp_no_user_credentials` e a agenda é desligada.
- Usar serviços MCP cuja classe de credencial seja `per_user`, `shared` ou `unverified`. Só a classe `databricks` é
  admitida, e só serviços do catálogo MCP dos administradores.
- Chamar `web_search` enquanto a política de ferramentas da organização a mantiver desligada.
- Rodar uma definição diferente da aprovada, nem sobreviver à sua aprovação.

## A que dados uma execução sem supervisão chega

Este é o ponto a ler antes de aprovar.

`genie_one` e as ferramentas MCP da classe `databricks` leem dados do Unity Catalog **com as permissões do service
principal, não as do dono**. Portanto um agente agendado pode ver dados que o dono não vê, se o service principal
recebeu acesso a eles, e não vê dados que o dono vê, se o service principal não recebeu.

O que decorre disso para os administradores:

- **Conceda ao service principal apenas dados que todo dono de agente possa ver.** Trate as permissões do service
  principal como o teto do que qualquer agente agendado pode ler.
- A tela de aprovação lista cada ferramenta do agente e marca as que leem dados do workspace. Aprove essas com
  critério.
- Um agente que só usa `web_search`, `generate_image` ou as ferramentas de deck, planilha e documento não lê dados do
  workspace.
- O resultado vai apenas para o chat do dono. Não existe canal de entrega por e-mail, webhook ou outro.
- Trate a saída das ferramentas como não confiável: uma página ou uma tabela pode conter texto que tenta conduzir o
  agente. Por isso o conjunto de ferramentas é fixado na aprovação, cada ferramenta tem o mínimo de privilégio e a
  execução não tem credenciais por usuário.

O AI Prism não altera nenhuma permissão no workspace. Dar acesso ao service principal é uma decisão do operador, tomada
no Unity Catalog.

## Referência: API HTTP

Donos (`/api/agents`): `GET status`, listar, criar, obter, `PATCH` (exige `revision`; uma desatualizada responde
`409 conflict`), excluir, `submit`, `enable`, `disable`, `run`, `runs`, `tool-options` (somente leitura: os tipos de ferramenta e os serviços do catálogo gerenciados pelo Databricks que um
agente pode usar, com a política de ferramentas da organização aplicada) e `schedule-preview` (somente leitura: descreve um agendamento e lista as próximas três
execuções com as mesmas funções do agendador, sem tocar em nenhum registro). Um registro que não é do solicitante responde
`404 not_found`, exatamente como um que não existe.

Administradores (`/api/admin/agents`): a fila de revisão com o hash atual e a identidade de cada ferramenta, `approve`
(`expectedHash`, `days` opcional), `reject` (`reason`), `revoke` e `settings` (leitura e escrita).

Os erros trazem um código estável em `error` e em `code`; a interface o traduz. Erros de execução que desligam a agenda
na hora: `approval_expired`, `approval_changed`, `tool_not_admitted`, `model_not_allowed`, `sp_model_denied`,
`sp_no_user_credentials`, `sp_permission_denied`. Três falhas transitórias seguidas (`sp_unavailable`, `gateway_error`,
`timeout`, `lease_lost`, `lease_expired`, `db_error`) também a desligam.
