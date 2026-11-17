### Fixed

- **Teste de linearidade do sanitizador de CSS sem flake**: os testes de "~2 MB de CSS malformado"
  comparavam o tempo de 1 MB e de 2 MB e falhavam sob carga de CPU (8 de 30 rodadas com todos os
  núcleos ocupados), sem regressão real. Agora a linearidade é medida por **trabalho**, não por tempo:
  `cssScanWork` (`server/sanitizeDsHtml.js`) conta cada caractere que a passada de CSS lê, inclusive
  a leitura antecipada, e o teste exige no máximo 8 leituras por caractere e no máximo 5× as leituras
  para 4× a entrada (linear dá 4×, quadrático 16×). Um teste fixa as chamadas de busca nativas da
  passada (`indexOf`, regex…), para que uma nova busca não fique fora da contagem, e um teto de 5 s
  por 2 MB fica como rede de segurança. 30 de 30 rodadas passam sob a mesma carga.
