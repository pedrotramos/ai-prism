### Changed

- **Título da sessão, classificador de intenção e rótulos de assets do DS agora usam o Claude Haiku 5.5.**
  O Haiku 4.5 está sendo aposentado, então as chamadas auxiliares migraram para o 5.5 (uma única constante,
  `AUX_FAST_MODEL`). Como o 5.5 rejeita `temperature`, essas chamadas não a enviam mais, e pedem o menor
  esforço de raciocínio (`low`) para que o raciocínio oculto não consuma o orçamento minúsculo de tokens.
  O timeout do classificador de intenção continua em 4s (ele é aguardado antes do primeiro token, e a meta
  de primeiro token é p95 <= 4s); ao estourar, vale o resultado do regex, e o título continua caindo no
  trecho da mensagem. A extração de memória usa o mesmo modelo auxiliar e também passa ao 5.5. O Haiku 4.5 segue no catálogo, desativado por padrão, para quem já o
  escolheu. Só uma chamada real de título foi feita (2,14s); a distribuição de latência não foi medida. READMEs (en, pt-BR, es) atualizados.
