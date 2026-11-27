### Changed

- **Título da sessão, classificador de intenção e rótulos de assets do DS agora usam o Claude Haiku 5.5.**
  O Haiku 4.5 está sendo aposentado, então as chamadas auxiliares migraram para o 5.5 (uma única constante,
  `AUX_FAST_MODEL`). Como o 5.5 rejeita `temperature`, essas chamadas não a enviam mais, e pedem o menor
  esforço de raciocínio (`low`) para que o raciocínio oculto não consuma o orçamento minúsculo de tokens.
  O timeout do classificador de intenção subiu de 4s para 6s (o 5.5 levou 1,2–2,0s em média numa sondagem de
  02/11/2026 e chegou a estourar os 4s); ao estourar, continua valendo o resultado do regex, e o título
  continua caindo no trecho da mensagem. O Haiku 4.5 segue no catálogo, desativado por padrão, para quem já o
  escolheu. A latência dessa configuração não foi medida ao vivo. READMEs (en, pt-BR, es) atualizados.
