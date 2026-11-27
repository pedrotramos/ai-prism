<!-- i18n: source=docs/install-from-zip.md source-hash=9bce60a2a7d2bbd0b5a0fae5735be508f8127e34 status=machine -->
# Instalar o AI Prism a partir de um ZIP

[English](../install-from-zip.md) · **Português (Brasil)** · [Español](../es/install-from-zip.md)

> Esta tradução foi feita com ajuda de IA e aguarda revisão nativa. Em caso de dúvida, a [versão em inglês](../install-from-zip.md) é a referência.

Para quem recebe o AI Prism como arquivo, em vez de clonar o repositório. O ZIP traz o app
já construído, então quem instala não precisa de git nem de build com Node: o notebook do
Workspace pode fazer a instalação inteira, ou você roda `deploy.sh` / `deploy.ps1` num
terminal. Nos dois casos, um **guarda da pasta** confere se a pasta é exatamente o que o ZIP
continha antes de qualquer coisa ser enviada ao seu workspace.

## O que é o ZIP

O `ai-prism-<version>.zip` é montado por quem mantém o projeto com
`scripts/build-customer-zip.sh`. Ele contém:

- o código commitado daquela versão mais um `server-dist/` e um `client/dist/` **novos** (os
  artefatos que o App executa), a partir de uma lista explícita: o bundle, `app.yaml`,
  `deploy.sh`, `deploy.ps1`, o notebook instalador, `bundle/`, `dashboards/`, `server/`,
  `shared/`, `docs/`, os READMEs, `CHANGELOG.md` e `LICENSE`. Sem testes, sem
  `node_modules`, sem arquivos ocultos além de `.npmrc` e `.nvmrc`;
- tudo dentro de uma única pasta-raiz, **`ai-prism/`**, para que descompactar nunca espalhe
  arquivos no diretório atual. Cada pasta tem a sua própria entrada no ZIP, antes do
  conteúdo: o import do Workspace exige isso, senão falha no primeiro arquivo;
- o `package-lock.json` apontando para o registry público do npm;
- o `ai-prism-manifest.txt`: a versão, o commit e uma linha `<sha256>  <arquivo>` por
  arquivo (formato 2).

O ZIP é **reprodutível**: o mesmo commit gera o mesmo arquivo, byte a byte, em qualquer
fuso e com qualquer umask (toda entrada leva a data do commit, ou `SOURCE_DATE_EPOCH`).
Compare o sha256 do arquivo com o que quem mantém o projeto publicar.

## Opção A: instalar pelo Workspace (um só envio)

1. No Workspace, crie uma pasta **nova e vazia**.
2. Abra o menu da pasta (**⋮**) e escolha **Import → File**, depois selecione
   `ai-prism-<version>.zip`. O Databricks descompacta em `ai-prism/`.
3. Abra `ai-prism/Install AI Prism` e deixe o campo **source** vazio: o notebook acha o
   projeto sozinho e mostra a **versão do pacote** que encontrou.
4. Anexe um cluster clássico com modo de acesso **Dedicated / Single user**, preencha o
   **catalog** e rode com **action = `check`**. Ele não cria nada e roda o mesmo guarda da
   pasta do deploy, então uma pasta que mistura versões é recusada já aqui.
5. Troque **action** para `install` e rode de novo. A primeira instalação leva de 10 a 15
   minutos.

Os outros campos (serverless, sleep do Lakebase, usage policy, tags) estão descritos no
notebook e em [onboarding-deployment.md](onboarding-deployment.md). Se preferir, envie o ZIP
para um **Volume** do Unity Catalog e informe o caminho dele em **source**.

## Opção B: instalar pelo terminal

```bash
unzip ai-prism-<version>.zip          # cria a pasta ai-prism/
cd ai-prism
./deploy.sh --check-tree              # opcional: só confere a pasta
npm ci --include=dev                  # uma vez: os passos de banco do deploy usam o `pg`
./deploy.sh <PROFILE> [CATALOG]       # Windows: .\deploy.ps1 <PROFILE> [CATALOG]
```

Numa pasta de ZIP o deploy **pula o build** (os artefatos já vêm construídos e o manifesto
fixa o hash deles), então não precisa de ferramentas de build. Veja
[onboarding-deployment.md](onboarding-deployment.md) para as opções e para o que o deploy
faz, passo a passo.

## Atualizar

Importe (ou descompacte) cada versão nova numa **pasta nova e vazia**, ou apague a pasta
antiga antes. Importar um ZIP por cima de uma pasta `ai-prism/` que já existe **junta** os
arquivos e pode manter os da versão antiga, por isso o guarda recusa uma pasta assim. O
estado da instalação fica no seu workspace, não nessa pasta: uma pasta nova atualiza a mesma
instalação.

## O guarda da pasta

O `bundle deploy` envia a pasta **inteira** para o workspace e para o App e, numa pasta sem
git, não aplica o `.gitignore`. Um ZIP descompactado em Downloads ou na pasta do usuário
enviaria PDFs, chaves e o `~/.databrickscfg`. Por isso o `deploy.sh` e o `deploy.ps1`
conferem a pasta primeiro, antes de qualquer chamada ao workspace e sem como desligar. O
deploy para, sem alterar nada, quando:

- a pasta é a sua pasta de usuário ou a raiz do disco;
- fora de um checkout git: falta o `ai-prism-manifest.txt`, ele não é do formato 2, a pasta
  tem um arquivo que ele não lista (ou um link de pasta), ou um arquivo listado falta ou tem
  outro sha256. Dois arquivos só precisam existir: o `app.yaml` (o deploy o reescreve) e o
  `models.json`, se a versão trouxer um. O notebook instalador é opcional: o Workspace o
  converte no import;
- dentro de um checkout git: há um arquivo sem versionar que o `.gitignore` e os excludes do
  sync do `databricks.yml` não cobrem (uma chave, `credentials.json`, um PDF). Quem
  desenvolve e sabe o que está fazendo pode usar `AI_PRISM_ALLOW_UNTRACKED=1`.

A primeira linha que os scripts mostram é `==> AI Prism <version> commit <sha>`.

O `./deploy.sh --check-tree` (`.\deploy.ps1 -CheckTree`) roda só esse guarda, mostra a versão
do pacote e sai: sem CLI, sem perfil, sem rede, sem gravar nem apagar nada.

Fora de um checkout git o deploy também apaga os `sync-snapshots` locais da CLI antes de
começar, para o sync ser completo: o ZIP carimba os arquivos com a data do commit, e um ZIP
mais antigo descompactado por cima de uma pasta já implantada deixaria o código novo fora do
App. Ele nunca segue um link ao fazer isso: se qualquer parte de
`.databricks/bundle/<target>/sync-snapshots` for um link, o deploy para sem apagar nada.

## Solução de problemas

| Mensagem ou sintoma | Causa | O que fazer |
|---|---|---|
| `this folder mixes versions of AI Prism` | Um ZIP foi importado por cima de uma pasta `ai-prism/` mais antiga | Importe numa pasta nova e vazia, ou apague a antiga antes |
| `file(s) that are not part of AI Prism` | Um arquivo que o ZIP não tem (cópia de uma chave, um PDF, um link) | Mova ou apague: ele seria enviado ao workspace |
| `ai-prism-manifest.txt is missing` | A pasta não é um checkout git nem a árvore do ZIP | Descompacte numa pasta vazia e rode de dentro de `ai-prism/` |
| `UNTRACKED file(s) outside .gitignore` | Um checkout git com arquivos que o sync enviaria | Versione, ignore, mova ou use `AI_PRISM_ALLOW_UNTRACKED=1` |
| `Error importing ai-prism-<version>.zip` | Um ZIP sem entradas de pasta | Use o ZIP montado por `scripts/build-customer-zip.sh` |

## Para quem mantém: montar o ZIP

```bash
npm ci --include=dev                    # uma vez: o .npmrc omite as devDependencies, onde ficam vite e esbuild
./scripts/build-customer-zip.sh         # grava dist/ai-prism-<version>.zip (dist/ não é versionado)
```

O script lê a árvore **commitada** (`git archive HEAD`), então alterações não commitadas não
entram (ele avisa). Ele constrói `server-dist/` e `client/dist/` numa pasta temporária e não
tem `--skip-build`. No fim, confere que nada só de desenvolvimento (testes, `node_modules`,
`.git`, `.github`, arquivos ocultos, logs, zips) entrou no pacote e que toda pasta tem a sua
entrada. O `tests/customerZip.test.mjs` roda tudo isso, inclusive um `databricks bundle sync
--dry-run` de verdade numa pasta sem git e num checkout git.
