<!-- i18n: source=docs/user-guide.md source-hash=0035537f846dadf9d546e4501debe0c0ef6432e4 status=current -->
# Guia do usuário

[English](../user-guide.md) · **Português (Brasil)** · [Español](../es/user-guide.md)

Como se localizar no AI Prism. Cada seção cobre uma parte da tela; as seções
do compositor, do chat e do shell do app entram ao lado desta.

## Compositor

O compositor é a caixa de mensagem na parte de baixo de cada conversa. Escreva
o pedido, anexe o que o modelo deve ler e envie.

### Escrever e enviar

- **Enter** envia a mensagem. **Shift+Enter** quebra a linha.
- A caixa cresce com o texto, até umas oito linhas; depois disso, rola.
- Sua mensagem aparece na conversa assim que você envia, antes de a resposta
  começar.
- Enquanto a resposta está sendo escrita, o botão Enviar vira **Parar**.
- Nada pede confirmação: a mensagem é enviada e o comando roda na hora.

### Adicionar arquivos e imagens

Selecione **+** (à esquerda da caixa) para abrir um menu curto:

| Item | O que faz |
|---|---|
| **Anexar documentos** | Escolhe documentos, planilhas, PDFs ou imagens. O texto deles é lido e enviado com a mensagem. |
| **Adicionar imagens** | Escolhe só imagens: capturas de tela, fotos, diagramas. Modelos com visão olham para elas. |
| **Adicionar áudio ou vídeo** | Aparece só quando o workspace transcreve mídia. A gravação vira texto antes de o modelo ler. |
| **Comandos** | Abre o menu de comandos (o mesmo que digitar `/`). |

Você também pode **colar** uma captura de tela ou um arquivo copiado na caixa,
ou **arrastar e soltar** arquivos sobre o compositor. Cada anexo aparece como
um chip acima da caixa; imagens mostram uma miniatura. Remova um anexo pelo
botão **×** dele. Uma mensagem aceita até 10 anexos.

### Comandos

Digite `/` no início da caixa para abrir o menu de comandos. Continue
digitando para filtrar. Cada comando tem um nome em cada idioma da interface,
e os acentos são opcionais: `/historico`, `/histórico`, `/history` e
`/historial` funcionam. Espaços extras no fim são ignorados.

| Comando (pt · en · es) | O que faz |
|---|---|
| `/compactar` · `/compact` · `/compactar` | Resume a conversa até aqui para liberar contexto. O texto depois do comando diz ao resumo o que manter, por exemplo `/compactar mantenha os números`. |
| `/contexto` · `/context` · `/contexto` | Mostra quanto do contexto do modelo esta conversa usa. |
| `/nova` · `/new` · `/nueva` | Começa uma nova conversa. |
| `/modelo` · `/model` · `/modelo` | Lista os modelos; escolha um para trocar o desta conversa. O texto depois do comando filtra a lista, por exemplo `/modelo sonnet`. |
| `/skills` | Abre suas skills nas Configurações. |
| `/custo` · `/cost` · `/costo` | Mostra quanto esta conversa custou. |
| `/historico` · `/history` · `/historial` | Abre o histórico de conversas. |
| `/configuracoes` · `/settings` · `/ajustes` | Abre as Configurações. |
| `/ajuda` · `/help` · `/ayuda` | Lista os comandos disponíveis aqui e os atalhos de teclado. |

O menu só lista os comandos que funcionam na sua instalação. Um comando
indisponível, ou qualquer outro texto que comece com `/`, vai para o modelo
como uma mensagem comum.

**Skills.** Suas skills ativas também aparecem no menu. Escolher uma, ou
digitar `/<nome-da-skill>` antes do pedido, fixa a skill naquela mensagem.
Ela aparece como um chip acima da caixa, vale só para a próxima mensagem e
pode ser removida pelo **×**.

### Voz

- O **microfone** dita na caixa, no idioma da interface. Selecione de novo
  para parar.
- O botão de **onda sonora** abre o modo de voz, uma conversa falada com o
  modelo.

O ditado precisa de um navegador com reconhecimento de fala, como Chrome ou
Edge.

### Teclado e acessibilidade

| Tecla | Onde | Ação |
|---|---|---|
| Enter | caixa de mensagem | envia, ou escolhe o comando destacado |
| Shift+Enter | caixa de mensagem | nova linha |
| `/` | início da caixa | abre o menu de comandos |
| ↑ / ↓ | menu de comandos | move o destaque |
| Tab | menu de comandos | escolhe o comando destacado |
| Esc | qualquer menu ou a ajuda | fecha; o texto continua |
| Enter, Espaço ou ↓ | botão **+** | abre o menu no primeiro item |
| ↑ / ↓, Home / End | menu **+** | move entre os itens |

O compositor funciona sem mouse. Leitores de tela anunciam a caixa como um
campo de texto de várias linhas e o comando destacado conforme você percorre o
menu. Os botões têm pelo menos 44 px de altura no celular e 32 px em telas
maiores. O elemento com foco sempre mostra um contorno visível.
