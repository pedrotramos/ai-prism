### Security

- **Cartão de administração das origens externas de recursos (md-exfil T3).** A aba Administradores ganhou o
  cartão "Origens externas de recursos": o administrador adiciona, remove e salva as origens `https` de onde
  imagens, fontes e folhas de estilo podem carregar. Cada entrada é validada no cliente com as mesmas regras do
  servidor (sem curinga, `http`, caminho, IP ou hosts da plataforma) e as origens que o servidor recusar são
  listadas. O cartão mostra, somente leitura, o piso definido por `EXTERNAL_ASSET_ORIGINS` e o modo atual
  (`enforce` ou `report`), e avisa que uma origem permitida pode receber o que o modelo escrever em uma URL de
  imagem, que a mudança chega à política em cerca de 15 s e vale só para páginas carregadas depois, e que a origem
  libera apenas imagens, fontes e folhas de estilo. Quem não é administrador não vê o cartão. Textos em pt-BR, en e es.
