<!-- i18n: source=docs/agents.md source-hash=f4cdf97f11603fca39bdbf2e79af96c22cbf66bb status=current -->
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
