### Added

- **Instruções e arquivos do projeto chegam ao turno** (`server/projectContext.js`, ADR 0013). Até aqui as
  instruções (até 20.000 caracteres) e os arquivos de um projeto eram guardados, mas nenhum turno os lia.
  Agora todo turno de uma conversa de projeto, em `/api/chat`, `/continue` e `/regenerate`, leva as instruções
  por inteiro e os arquivos na ordem de envio, até `PROJECT_CONTEXT_FILES_MAX_TOKENS` tokens (padrão 32.000;
  `0` desliga os arquivos). O primeiro arquivo que não cabe entra em parte se sobrar ao menos 1.000 tokens; os
  que não foram lidos são nomeados ao modelo. Entra pelo registro de provedores de contexto (sem tocar em
  `server/turn.js` nem `server/llm.js`), com a leitura feita como quem pergunta (RLS): membros, direto ou por
  grupo, recebem o mesmo contexto; quem não é membro e o admin do app não recebem nada. A saída é idêntica
  byte a byte para um projeto inalterado (cache de prompt) e a leitura tem limite de 1,5 s: lenta ou
  falhando, o turno segue sem o projeto.
- **`GET /api/projects`** devolve `{ projects, limits }` com os limites reais (nome, descrição, instruções,
  tamanho e número de arquivos, caracteres extraídos, orçamento do contexto, extensões aceitas).
- **`GET /api/projects/:id/files`** informa, por arquivo, `context` (`full` | `partial` | `excluded`),
  `context_tokens`, `extracted_chars` e `truncated_at_upload`, e os totais em `context`, pela mesma seleção
  que o turno usa.
- **Autoria por mensagem** (migração `0009_project_context`, ADR 0014): `chat_messages.sent_by`, carimbado
  por um trigger a partir da identidade da transação (o cliente não consegue falsificar); as mensagens da
  API trazem `sent_by` (nulo nas antigas). A coluna `project_files.context_tokens` guarda a contagem feita no
  envio (arquivos antigos são contados no banco, na leitura, sem trazer o texto para o app e sem gravar nada: `project_files` não tem política de UPDATE de propósito).
- **Leitura do contexto limitada também no banco**: a transação roda com `SET LOCAL statement_timeout` logo abaixo do limite de 1,5 s do provedor, então o Postgres cancela a consulta lenta e a conexão volta ao pool (antes só se parava de esperar e a conexão ficava ocupada até 60 s). Só o texto dos arquivos que a seleção lê é buscado; com orçamento 0 nenhum texto é transferido.
