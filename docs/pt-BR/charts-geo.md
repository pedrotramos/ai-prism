<!-- i18n: source=docs/charts-geo.md source-hash=2d98104a484f1701d177237f3f3b90b341972b3d status=current -->
# Gráficos: rosca, mapa e gráficos do chat em apresentações e documentos

[English](../charts-geo.md) · **Português (Brasil)** · [Español](../es/charts-geo.md)

## Tipos de gráfico

Além de barras, linhas, área, pizza, tabela dinâmica, mapa de calor, dispersão e histograma, uma resposta
do chat pode trazer:

- **rosca**: partes de um todo, com o total no meio e a participação de cada fatia na legenda. O servidor
  transforma uma medida aditiva (receita, unidades) em até cinco fatias mais "Outros".
- **mapa**: coroplético. Cada linha dos dados é uma região e seu valor; o tom segue o valor.

Como em todo gráfico, os números vêm dos dados (um anexo ou o resultado de uma consulta), nunca de números
escritos pelo modelo. O modelo só escolhe qual gráfico mostrar.

## Conjuntos geográficos

Um mapa desenha as regiões de um **conjunto geográfico**: formas já projetadas em um único `viewBox` SVG,
de modo que o navegador e o servidor desenham a mesma imagem e nenhuma biblioteca de mapas nem projeção
roda na hora de pintar.

| Id do conjunto | Regiões | Casa com rótulos como |
|---|---|---|
| `world-countries` | 174 países | códigos ISO (`BR`, `BRA`) e nomes em inglês, português e espanhol |
| `br-states` | 27 estados do Brasil | siglas (`SP`) e nomes. Um exemplo de conjunto regional |

Uma coluna de dados vira mapa só quando pelo menos 70 % dos rótulos (e no mínimo 3) nomeiam regiões de um
mesmo conjunto. Um rótulo que não casa com nada fica fora do mapa e dentro da tabela de dados.

### Adicionar um conjunto próprio

1. Obtenha um arquivo GeoJSON das regiões (Natural Earth, o instituto de estatística do seu país, ...).
2. Converta:

   ```bash
   node scripts/build-geo.mjs regions.geojson \
     --id my-regions --name "My regions" --id-prop code --name-prop name \
     --aliases aliases.json --projection mercator --width 800 --json my-regions.json
   ```

   - `--id-prop` / `--name-prop`: as propriedades das features com o código e o nome da região.
   - `--aliases`: opcional, `{ "SP": ["São Paulo", "Sao Paulo"] }`, outras grafias por código.
   - `--projection equirect|mercator`, `--width`, `--decimals`, `--tolerance`: tamanho contra detalhe (os
     conjuntos incluídos têm cerca de 80 KB cada). `--bbox lonMin,latMin,lonMax,latMax` recorta a vista.
   - `--ts shared/geo/mySet.ts` grava um módulo TypeScript, para embutir um conjunto no app.
3. Coloque o `.json` em um diretório e aponte `GEO_DATA_DIR` para ele (variável de ambiente do Apps).
   O servidor lê o diretório uma vez, na partida: no máximo 20 arquivos de 6 MiB e 400 regiões por conjunto.
   Um arquivo que não é um conjunto válido é ignorado e registrado no log. Um conjunto não substitui um id
   incluído no app.

Nada mais muda. Ao montar um mapa, o assistente pode indicar um conjunto como dica (a política lista os ids
incluídos); o servidor compara os rótulos com todos os conjuntos, inclusive o seu, e fica com o que melhor se
ajusta. Se nenhum serve, o mapa não é desenhado.

## Gráficos do chat em apresentações e documentos

Quando um turno pode criar uma apresentação ou um documento, o assistente também recebe o **inventário de
visualizações** da conversa: os gráficos já mostrados (`viz_<mensagem>_<n>`) e os montados a partir de
anexos e consultas (`candidate_<n>`). Ele decide quais sustentam uma conclusão; ninguém precisa pedir.

- **Apresentação**: um slide `chart` traz `"viz": "<id>"`. O servidor desenha o gráfico como PNG e o coloca
  no slide, então a prévia do Studio e a exportação PPTX o mostram. A edição por IA de um slide mantém a figura.
- **Documento**: uma linha `{{viz:<id>}}` vira a figura mais uma pequena tabela de dados. O Studio, a
  impressão e a exportação DOCX a levam (o DOCX contém a própria imagem).
- **"Usar em slides"** em um gráfico do chat coloca no campo de mensagem um pedido de apresentação, para o
  usuário enviar.

Um id fora do inventário é descartado, então o modelo não consegue mostrar um gráfico que a conversa não tem.

### O motor de rasterização

Os PNG são desenhados no servidor com `@resvg/resvg-wasm` e a fonte Inter, nos tokens claros do AI Prism.
`npm run bundle` copia `resvg.wasm` e os três arquivos Inter para ao lado do bundle do servidor. Se faltarem,
o app registra `CHART_RASTER_UNAVAILABLE` na partida; gráficos, mapas e o resto do app seguem funcionando,
apresentações e documentos apenas ficam sem a figura, e `GET /api/sessions/:id/visuals/:vizId.png` responde 503.

## Comportamentos relacionados

- **Genie**: as chamadas à API REST do Genie são repetidas duas vezes (0,5 s e depois 1,5 s) quando a conexão
  cai ou o gateway responde 429, 502, 503 ou 504. Qualquer outro status é informado na hora.
- **Várias abas**: quando um turno termina em uma aba do navegador, as outras abas do mesmo navegador
  atualizam a lista de conversas e recarregam essa conversa se for a que está aberta.
