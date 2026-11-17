### Fixed

- **Teste de navegador instável no CI** (`client/src/styles/tokens.browser.test.js`): falhava em
  cerca de 3 de 4 execuções com `ENOTEMPTY: directory not empty, rmdir '<perfil>/Default'`, porque
  o perfil temporário do Chrome era apagado enquanto os processos auxiliares do Chrome (que
  sobrevivem ao processo principal) ainda gravavam nele. A limpeza agora espera o `close` do
  processo (todos os auxiliares encerrados), com limite de tempo e SIGKILL de reserva, remove os
  diretórios temporários com novas tentativas e só avisa, sem reprovar o teste, se a remoção falhar
  (`tests/helpers/browserProcess.mjs`, testado por `tests/browserProcess.test.mjs`). O que o teste
  verifica não mudou.
