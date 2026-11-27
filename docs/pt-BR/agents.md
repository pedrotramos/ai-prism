<!-- i18n: source=docs/agents.md source-hash=590240c98310ae643f76874c73fe41a75efa2f4c status=current -->
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

## Versões, restauração e compartilhamento

Cada salvamento de um agente é uma **versão**: a versão 1 é o primeiro salvamento e cada salvamento seguinte (qualquer
mudança, inclusive de nome ou descrição) é o número seguinte. Uma versão nunca muda depois de salva; o banco recusa
qualquer atualização do conteúdo dela, para qualquer pessoa. Um salvamento que não muda nada não vira versão.

- **Histórico.** *Versões*, no cartão de um agente, lista todas as versões (quem e quando, de onde foi copiada, se está
  aprovada ou compartilhada) e mostra o que mudou desde a anterior: um diff por linha das instruções e do prompt, as
  ferramentas adicionadas ou removidas e o modelo, o esforço, o agendamento, o idioma, o nome e a descrição antes e
  depois. Um agente salvo antes deste recurso não tem histórico anterior: ele começa na versão que tinha quando você
  abre o histórico pela primeira vez.
- **Restaurar** salva o conteúdo de uma versão antiga de novo como a versão mais recente. Nada é reescrito nem
  excluído. Passa pelas mesmas verificações de um salvamento, então um modelo ou uma ferramenta que não existe mais não
  volta; e, como qualquer edição do escopo de aprovação, leva um agente aprovado ou aguardando de volta a rascunho (a
  tela avisa antes).
- **Duplicar** copia qualquer versão sua para um novo agente seu em rascunho. Conta no limite de 10 agentes.
- **O compartilhamento é aprovado duas vezes, e nunca pela aprovação de agendamento.** Primeiro o **conteúdo de uma
  versão**: *Enviar para aprovação de compartilhamento*, numa versão, pede a um administrador que aprove exatamente essa
  versão. Depois cada **destinatário**: você pode adicionar uma pessoa (e-mail), um grupo do workspace ou todos no app, e
  cada um é um *pedido* que um administrador aprova ou rejeita, fixado na versão que ele nomeia. Nada vale até que a
  versão e o destinatário estejam aprovados, então adicionar alguém depois que o conteúdo foi aprovado nunca o alcança
  sem uma decisão. Mover um destinatário já aprovado para outra versão **aprovada** não exige nova decisão; qualquer
  outra mudança, ou uma pessoa ou grupo novo, é um novo pedido. Revogar qualquer das aprovações interrompe o
  compartilhamento na hora. Um agente pode ter até 50 destinatários (mover um destinatário já listado não conta). A fila
  de revisão mostra o que precisa de decisão, pedidos primeiro, com os destinatários de cada versão e o que mudou desde
  a última versão aprovada do mesmo agente; ela é paginada, então um pedido antigo nunca fica escondido atrás de
  salvamentos mais novos.
- **O agendamento não muda e é separado** ([ADR 0017](../adr/0017-agent-definitions-approval.md)): a aprovação que deixa
  o app executar um agente sem supervisão continua sendo a do agente, continua sendo anulada quando o conteúdo atual muda
  e uma execução continua usando o snapshot aprovado. Enviar ou aprovar o *agente* nunca aprova uma versão para
  compartilhar, e aprovar uma versão nunca aprova o agente. Um agente que estava aguardando ou aprovado antes deste
  recurso começa com uma versão não enviada: para compartilhá-lo, envie essa versão uma vez.
- **Quem lê.** Quem recebe encontra o agente em **Compartilhados com você**, lê a versão aprovada, pode testá-la no chat
  ou copiá-la para os próprios agentes como rascunho que precisa da própria aprovação. Quem recebe **não executa** o
  agente do dono: ele continua rodando só com a aprovação do dono e como o app. Quem recebe nunca vê rascunhos, versões
  mais antigas ou mais novas, nem com quem mais o agente é compartilhado.
- **Um administrador que é dono do agente** pode aprovar a própria versão ou o próprio destinatário (uma instalação com
  um único administrador não tem mais ninguém). É permitido, o cartão de revisão diz que é o agente do próprio
  administrador e o registro de auditoria anota como autoaprovação.

Registro da decisão: [ADR 0020](../adr/0020-agent-versions.md). Migração: `0017_agent_versions`.

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

Versões e compartilhamento (donos): `GET /api/agents/:id/versions` (`before`, `limit`; da mais nova à mais antiga, com os
destinatários fixados em cada uma), `POST /api/agents/:id/versions/:version/restore`, `POST
/api/agents/:id/versions/:version/submit`, `POST /api/agents/:id/duplicate` (`version`, `name`; também é como quem recebe
copia uma versão compartilhada), `GET` e `POST /api/agents/:id/shares` (`version`, `kind` entre `user`, `group` ou `app`,
`principal`; a lista traz o estado de cada destinatário e o da versão dele, e um novo é um pedido pendente), `DELETE
/api/agents/:id/shares/:kind/:principal` e `GET /api/agents/shared-with-me`. Administradores: `GET
/api/admin/agent-versions` (`status`, `limit`, `offset`; responde `{ versions, hasMore }`, por padrão o que precisa de
decisão, pedidos primeiro), `POST /api/admin/agent-versions/:id/:version/approve|reject|revoke` para o conteúdo de uma
versão e `POST /api/admin/agent-shares/:id/:kind/:principal/approve|reject|revoke` (`expectedVersion`, e `reason` para
rejeitar) para um destinatário; cada um é uma decisão e uma linha de auditoria (`agent.version.*`, `agent.share.*`). Um
destinatário só é aprovado para uma versão aprovada (`409 version_not_approved`), e uma fixação que mudou depois que a tela
carregou é `409 stale`.

Os erros trazem um código estável em `error` e em `code`; a interface o traduz. Erros de execução que desligam a agenda
na hora: `approval_expired`, `approval_changed`, `tool_not_admitted`, `model_not_allowed`, `sp_model_denied`,
`sp_no_user_credentials`, `sp_permission_denied`. Três falhas transitórias seguidas (`sp_unavailable`, `gateway_error`,
`timeout`, `lease_lost`, `lease_expired`, `db_error`) também a desligam.
