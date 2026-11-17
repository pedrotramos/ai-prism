[English](README.md) · **Português (Brasil)** · [Español](README.es.md)

# Catálogos de strings da UI

Todo o texto da interface web vem destes catálogos, um por idioma: português (`pt`), inglês
(`en`) e espanhol (`es`). Cada idioma é dividido em **domínios**, um arquivo por área da UI,
para que partes diferentes da UI mudem seus textos sem editar o mesmo arquivo.

## Estrutura

```text
client/src/lib/locales/
├── index.js              # merges the domain files into one flat catalog per language
├── catalogs.test.js      # snapshot, parity and partition checks
├── __snapshots__/        # <domain>.json: the expected strings, all three languages
├── pt/  en/  es/         # same file names in each language
│   ├── common.js
│   ├── composer.js
│   ├── message.js
│   ├── sidebar.js
│   ├── welcome.js
│   ├── settings.js
│   ├── admin.js
│   ├── studios.js
│   └── errors.js
```

Cada arquivo de domínio exporta um objeto plano com entradas `'namespace.chave': 'texto'`.
`client/src/lib/i18n.jsx` importa os catálogos unidos de `index.js`; os componentes chamam
`useT()` e `t('sidebar.newChat')`. Marcadores como `{name}` são preenchidos por
`t(chave, { name })`. Se faltar uma chave em um idioma, a UI mostra o texto em `pt` e, depois, a
própria chave.

## Qual arquivo guarda uma chave

O **namespace** é a parte da chave antes do primeiro ponto (`sidebar` em `sidebar.newChat`).
Cada namespace vive em exatamente um arquivo de domínio:

| Domínio | Namespaces | UI |
|---|---|---|
| `common` | `common`, `notify`, `chat`, `compaction`, `skillCreator`, `tools`, `meter`, `time`, `shell`, `appError`, `modelPicker` | botões comuns, casca do app (telas de erro, não encontrado, erros de turno), textos amigáveis de erro, seletores do cabeçalho (modelo, tools, taxímetro), tempo relativo |
| `composer` | `composer`, `voice` | caixa de mensagem, modo de voz |
| `message` | `message`, `reasoning`, `loading`, `deckQuestions`, `chart`, `table`, `spreadsheetBlock`, `deckBlock`, `imageBlock`, `docBlock` | mensagens do chat e blocos em linha |
| `sidebar` | `sidebar`, `history` | barra lateral, página de histórico |
| `welcome` | `welcome` | tela de boas-vindas |
| `settings` | `settings`, `personal`, `mcp`, `skills`, `templates`, `templateInspector` | abas de configurações que todo usuário vê |
| `admin` | `admins`, `models`, `toolsAdmin`, `mcpAdmin` | abas de administração da organização |
| `studios` | `docStudio`, `richText`, `deckStudio`, `deckPreview`, `layerTree`, `inspector`, `sheetStudio` | estúdios de apresentação, planilha e documento |
| `errors` | `errors` (ainda sem chaves) | texto de erro comum a toda a UI |

Texto de erro de uma tela só (por exemplo `docStudio.saveError`) fica no namespace dessa tela,
para que um único responsável edite um único arquivo.

## Adicionar ou mudar uma chave

1. Ache o arquivo dono do namespace (tabela acima ou o comentário no topo de cada arquivo).
2. Adicione ou edite a entrada em `pt/<domínio>.js`, `en/<domínio>.js` **e** `es/<domínio>.js`,
   com a mesma chave nos três.
3. Regere os snapshots e revise o diff. Ele deve mostrar só a sua mudança:

   ```bash
   UPDATE_LOCALE_SNAPSHOTS=1 node --test client/src/lib/locales/catalogs.test.js
   git diff client/src/lib/locales/__snapshots__/
   ```

4. Rode os testes sem a variável (próxima seção) e commite catálogos e snapshots juntos.

Um **namespace novo** vai para o domínio dono da UI dele. Nunca adicione chaves de um namespace
existente em outro arquivo de domínio; os testes rejeitam isso.

## Adicionar um domínio

1. Crie `pt/<domínio>.js`, `en/<domínio>.js` e `es/<domínio>.js` (comece com `export default {}`).
2. Em `index.js`, importe os três arquivos, acrescente o domínio em `DOMAINS` e inclua-o em cada
   idioma de `PARTS`.
3. Acrescente o domínio na lista `DOMAINS` de `catalogs.test.js`.
4. Regere os snapshots (passo 3 acima). Isso cria `__snapshots__/<domínio>.json`.
5. Mova só namespaces inteiros; um namespace não pode ficar dividido entre dois domínios.

## Testes

`catalogs.test.js` verifica que:

- cada arquivo de domínio tem exatamente as strings gravadas em `__snapshots__/<domínio>.json`, e
  os catálogos unidos batem, então nenhum texto muda, some ou aparece sem aparecer na revisão;
- `pt`, `en` e `es` têm as mesmas chaves, por domínio e no total (nenhum idioma cai no fallback
  em silêncio);
- cada namespace vive em exatamente um arquivo de domínio, então a ordem do merge em `index.js`
  não importa;
- todo valor é uma string não vazia.

Rode a partir da raiz do repositório:

```bash
node --test client/src/lib/locales/catalogs.test.js
```

Ele também roda junto com os demais testes unitários (`node --test` sobre os arquivos
`*.test.js` / `*.test.mjs` em `server shared scripts tests client/src`).
