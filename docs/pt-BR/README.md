<!-- i18n: source=docs/README.md source-hash=57e0042d7383f191bdac8968187bb1519338f24c status=current -->
# Documentação

[English](../README.md) · **Português (Brasil)** · [Español](../es/README.md)

Todos os guias do AI Prism, por tarefa. O texto de referência é o inglês; o
[status das traduções](../i18n-status.md) mostra quais páginas existem em português
e espanhol e se estão em dia. Algumas páginas ainda estão só em português, no
caminho da versão inglesa; elas ganham o texto em inglês numa fase seguinte.

## Deploy e operação

- [Guia do usuário](user-guide.md): como se localizar no app (barra superior, links de conversa, compositor, mensagens, o que acontece quando algo falha).
- [Onboarding e deploy](onboarding-deployment.md): do workspace vazio ao app rodando, em poucos comandos (`bundle deploy` + `apps deploy` + `bundle run`).
- [Custos e posicionamento](costs-and-positioning.md): quais recursos Databricks o AI Prism consome e por que o modelo compensa.
- [Operação](operations.md): saúde, logs, SLOs propostos e o runbook de deploy, rollback e diagnóstico.
- [Tags de recurso e atribuição de custo](tags.md): como o app marca o que cria no workspace.
- [Governança de frota](fleet-governance.md): dono, nomes, guardrails, atribuição de custo e descomissionamento de várias instalações.
- [Dashboards de custo e operação (AI/BI)](dashboards/README.md): auditoria de custos de IA, volume de uso e latência do gateway a partir das system tables.

## Segurança

- [Política de segurança](SECURITY.md): como reportar uma vulnerabilidade e quais controles o app tem.
- [FAQ de segurança](security-faq.md): respostas às objeções típicas de revisão, separando o que é do app e o que é da plataforma.
- [Modelo de ameaças](security-threat-model.md): ativos, atores, fronteiras de confiança, controles e lacunas declaradas.

## Integrações

- [Conectando MCPs](mcp-connections.md): registrar um MCP Service no Unity AI Gateway, publicá-lo no Catálogo MCP do app e conectá-lo dentro do AI Prism.
- [Agentes A2A](a2a.md): registrar agentes remotos (A2A 1.0), entrar com a conta Databricks, um provedor externo ou sem login, e chamá-los pelo chat.
- [Microsoft 365 via Microsoft Graph](../mcp-microsoft-graph.md): e-mail e calendário sem licença Copilot Studio Pro, com um servidor MCP próprio sobre o Graph.
- [Busca e leitura da web](web-search.md): as duas tools nativas de web e como desligá-las.

## Desenvolvimento

- [Contribuindo](CONTRIBUTING.md): fluxo de desenvolvimento, testes e QA, padrões de commit e pull requests.
- [Performance e carga](performance.md): como funciona o `npm run loadtest`, o `EXPLAIN` das consultas críticas e a última execução medida.
- [Registros de decisão de arquitetura](../adr/README.md): um arquivo por decisão. ADRs não são traduzidos; passam para o inglês numa fase seguinte.
- [Glossário](../glossary.md): as palavras do próprio app em inglês, português e espanhol, geradas a partir dos catálogos da interface.

## Traduções

O inglês é a versão canônica. Uma tradução espelha o caminho do inglês em
`docs/<locale>/` (`docs/pt-BR/operations.md` traduz `docs/operations.md`;
`SECURITY.md` e `CONTRIBUTING.md` viram `docs/<locale>/SECURITY.md` e
`docs/<locale>/CONTRIBUTING.md`). A exceção é o README da raiz:
`README.pt-BR.md` e `README.es.md`. A lista das páginas traduzidas e das que
ainda faltam fica em [i18n.json](../i18n.json).

A linha 1 de cada tradução registra a versão em inglês a que ela corresponde:

```md
<!-- i18n: source=docs/operations.md source-hash=<git blob sha of the English file> status=current -->
```

- `current`: corresponde àquela versão em inglês.
- `outdated`: o inglês mudou e a tradução foi marcada de propósito; a página mostra um aviso que aponta para o inglês.
- `machine`: tradução feita com ajuda de máquina, aguardando revisão nativa; também mostra um aviso.
- `stub`: um texto curto provisório que aponta para o inglês.

O `scripts/check-docs-i18n.mjs` falha quando o inglês muda e a tradução ainda diz
`current`, quando títulos, tabelas ou blocos de código divergem, quando um bloco de
código difere em algo além dos comentários, quando um link relativo ou âncora quebra,
ou quando falta o seletor de idioma abaixo do título. Quando você mudar uma página em
inglês:

```bash
node scripts/check-docs-i18n.mjs                     # o que está fora de sincronia
node scripts/check-docs-i18n.mjs --stamp docs/pt-BR/operations.md                    # depois de atualizar a tradução
node scripts/check-docs-i18n.mjs --stamp docs/es/operations.md --status outdated     # quando não deu para atualizar
node scripts/check-docs-i18n.mjs --report            # regenera docs/i18n-status.md
node scripts/check-docs-i18n.mjs --glossary          # regenera docs/glossary.md depois de mudar um texto da interface
```

Blocos de código ficam idênticos byte a byte em todos os idiomas: traduza só os
comentários. Quando um bloco tem texto que precisa ser traduzido (os rótulos de um
diagrama, por exemplo), coloque `<!-- i18n: code-translated en=<sha256-12> -->` na linha acima da
cerca de abertura, em todos os idiomas, onde `<sha256-12>` são os 12 primeiros
caracteres hexadecimais do SHA-256 do corpo do bloco em inglês (as linhas entre as
cercas). O verificador rejeita um marcador sem hash ou com hash desatualizado, para
que ele não sobreviva ao código em inglês; ele imprime o valor esperado. Para rascunhos feitos com ajuda de máquina,
use o guia de estilo do idioma ([pt-BR](.llm-prompt.md), [es](../es/.llm-prompt.md))
junto com o [glossário](../glossary.md), e peça revisão de um falante nativo antes
de o status virar `current`.

O mesmo script protege duas coisas além das traduções. Ele falha quando uma página
anuncia uma versão do Node.js mais antiga que o `engines` do `package.json`. E falha
quando um nome proibido aparece em qualquer arquivo de texto ou nome de arquivo do
repositório. A lista fica no [i18n.json](../i18n.json), em `prohibited`, como entradas
SHA-256 com salt, então o repositório nunca escreve os nomes. Para adicionar nomes,
escreva um por linha num arquivo privado fora do repositório e rode
`node scripts/check-docs-i18n.mjs --hash-terms <arquivo>`: ele imprime só as entradas a
colar em `prohibited.terms`. `DOCS_PROHIBITED_TERMS` (separado por vírgulas, por exemplo
vindo de um secret da CI) acrescenta termos na execução. A busca ignora maiúsculas,
acentos, espaços, hífens, sublinhados e quebras de linha, o erro nunca imprime o termo e,
com `--ci`, uma lista vazia falha.
