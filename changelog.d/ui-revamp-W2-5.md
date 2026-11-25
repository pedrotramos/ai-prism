### Fixed

- **Testes e2e mais estáveis para a versão 2.0.0.** Os testes que falhavam de forma intermitente em execuções
  completas passam a esperar por condições (o envio do composer, a abertura de cada View, o fim do carregamento
  de projetos) em vez de tempos fixos, e um teste que dependia do registro de chamadas do servidor de fixtures
  deixa de falhar ao ser repetido. Nenhum código do produto mudou.
