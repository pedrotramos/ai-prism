### Added

- **Membros do projeto leem os artefatos de um chat compartilhado, somente leitura (migração
  `0012_project_artifact_read`).** Até agora as apresentações, planilhas, documentos e imagens gerados por
  um membro apareciam como cartões quebrados para os outros. A nova política `aipj_member_read` (só
  `FOR SELECT`, participação como conjunto, sem chamada por linha) em `chat_decks`, `chat_spreadsheets`,
  `chat_documents` e `chat_images` deixa cada membro atual abrir e exportar o artefato; os getters devolvem
  `read_only: true` (imagem: cabeçalho `X-Artifact-Read-Only`) e qualquer salvamento ou edição com IA de
  quem não criou responde 403 `artifact_read_only`, antes de chamar o modelo. Quem sai do projeto, e um
  admin sem participação, continuam recebendo 404. Escritas seguem só do criador, no banco e no app.

### Fixed

- **Excluir um projeto agora apaga as imagens dos chats dele no volume.** `deleteProject` removia as
  linhas (CASCADE) e deixava os arquivos órfãos. Na mesma transação ele coleta os `volume_path` de todos os
  chats do projeto (de todos os membros) e, depois do commit, apaga os arquivos, no máximo 4 por vez; uma
  falha não derruba a requisição e é contada em um único aviso.
