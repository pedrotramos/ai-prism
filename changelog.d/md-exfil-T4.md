### Security

- **Imagens externas não carregam mais no chat, nos documentos e no README do design system (T4).** Uma imagem
  em markdown (`![](https://host/?dado=...)`) gerada pelo modelo ou vinda de uma ferramenta era buscada pelo
  navegador sem nenhum clique, o que vazava o conteúdo da URL. Agora toda imagem cuja origem não é do próprio app
  (nem `data:` de imagem, nem uma origem liberada pelo admin) vira um espaço reservado nomeado, "Imagem não
  carregada: texto alternativo (host)", que mostra o host e nunca é uma `<img>`, sem opção de "carregar mesmo
  assim". Vale para o texto da resposta (inclusive durante o streaming, em tabelas e com referências), para a
  página, o editor e a prévia do Document Studio e para o README do design system. Uma imagem liberada que falha
  ao carregar cai no mesmo espaço reservado. Enquanto `/api/me` não responde, a lista é vazia (falha fechada).
  O editor de texto rico preserva a sintaxe da imagem ao salvar. Imagens `data:` (raster e svg) agora aparecem.
