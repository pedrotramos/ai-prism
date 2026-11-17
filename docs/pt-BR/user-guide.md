<!-- i18n: source=docs/user-guide.md source-hash=429546680dc4a5e6d8d6e5236ea466ea31eac688 status=current -->
# Guia do usuário

[English](../user-guide.md) · **Português (Brasil)** · [Español](../es/user-guide.md)

Como se localizar no AI Prism. Cada seção cobre uma parte da tela; as seções
do compositor, do chat e do shell do app entram ao lado desta.

## Shell

O shell é tudo o que fica em volta de uma conversa: a barra superior, os links
para uma conversa, as notificações e o que acontece quando algo falha.

### A barra superior

A barra acima da conversa tem, da esquerda para a direita:

| Controle | O que faz |
|---|---|
| Menu (só no celular) | Abre a lista de conversas. |
| Modelo | O modelo que responde nesta conversa. A lista mostra primeiro três modelos **Recomendados**. **Mais modelos** abre o resto do catálogo, agrupado por provedor, com uma caixa de busca. Um modelo marcado **Só texto** não aceita imagens (ou **Imagens**, quando a maior parte do seu catálogo é só texto). |
| Tools | As ferramentas que o modelo pode chamar nesta conversa (Genie One, geração de imagens, Genie Agents, funções do Unity Catalog, índices de Vector Search, conexões MCP). O número no ícone é quantas estão ligadas. |
| Taxímetro | Quanto você gastou neste mês e, dentro de uma conversa, quanto ela custou até agora, a preço de tabela. No celular aparece só o ícone do medidor; toque nele para ver os valores. |
| Configurações | Preferências, skills, conexões MCP e, para admins, as configurações da organização. |

Os painéis de Modelo, Tools e Taxímetro fecham com **Esc** ou com um clique fora, e o foco do
teclado volta para o botão que os abriu. Na lista de modelos, as setas do teclado passam de um
modelo para outro. O painel de custos também fecha quando você troca de conversa ou usa os botões
de voltar e avançar do navegador.

As escolhas de modelo e de tools ficam salvas na conversa: ao reabri-la, elas voltam.

### Links para uma conversa

Cada conversa tem o próprio endereço (`…/#/chat/<id>`), então dá para salvá-la nos favoritos ou
usar voltar e avançar do navegador. `…/#/history` abre a lista de todas as conversas.

Se um link aponta para uma conversa que não existe, foi excluída ou não é sua, o AI Prism mostra
**Conversa não encontrada** e oferece **Voltar ao histórico** e **Nova conversa**. Ele nunca abre a
conversa de outra pessoa: toda leitura é limitada ao usuário conectado.

### Quando algo dá errado

**Um turno falha.** Se o modelo ou o serviço não conseguem responder (por exemplo, o AI Gateway
está temporariamente indisponível), sua mensagem continua na conversa e um cartão de erro aparece
no lugar da resposta. O cartão diz o que aconteceu em palavras simples e oferece:

- **Tentar de novo**: pede de novo. Se o servidor já guardou sua mensagem, ele gera a resposta que
  faltou; se não, envia a mensagem de novo com os mesmos anexos.
- **Copiar prompt**: copia sua mensagem, caso prefira reescrevê-la.
- **Detalhes**: a mensagem exata do servidor, útil para reportar o problema a um admin.

O mesmo cartão aparece quando **Regenerar** ou **Gerar resposta** falham. Quando uma regeneração
falha antes de uma nova resposta ser guardada, a versão anterior continua.

**Uma mensagem não pode ser exibida.** Se uma mensagem guardada estiver malformada, só ela é
trocada por "Não foi possível exibir esta mensagem." O resto da conversa continua funcionando.

**Algo quebra a página inteira.** Aparece "Algo deu errado" com um botão **Recarregar**. Suas
conversas ficam guardadas no servidor, então recarregar não perde nada que já foi enviado.

**Notificações.** Mensagens curtas aparecem no canto superior direito e somem sozinhas após alguns
segundos (os erros ficam um pouco mais). Apontar para a notificação, ou levar o foco do teclado até
ela, a mantém aberta para você ler os **Detalhes**. Leitores de tela as anunciam; erros são
anunciados na hora.

#### O que as mensagens de erro querem dizer

| Mensagem | Causa comum | O que fazer |
|---|---|---|
| Não foi possível conectar ao AI Prism | Sua rede, VPN ou proxy derrubou a conexão. | Verifique a conexão e tente de novo. |
| O serviço está temporariamente indisponível | O AI Gateway, o workspace ou o banco não responderam. | Tente de novo em instantes. |
| Muitas solicitações agora | Limite de taxa do endpoint do modelo ou do AI Prism. | Aguarde alguns segundos e tente de novo. |
| Sua sessão expirou | O token de login do proxy do Databricks Apps expirou. | Recarregue a página. |
| Você não tem permissão para isso | Falta um grant ao seu usuário (catálogo, Genie Agent, endpoint). | Peça ao admin do workspace. |
| Grande demais para enviar | Um arquivo ou mensagem acima do limite de upload. | Envie um arquivo menor ou divida-o. |
| Demorou demais e foi interrompido | Uma chamada de modelo ou tool atingiu o tempo limite. | Tente de novo, ou peça algo menor. |
| Algo deu errado no servidor | Um erro inesperado no servidor. | Tente de novo; se repetir, envie os **Detalhes** ao seu admin. |

## Navegação

### A barra lateral

A barra lateral à esquerda reúne tudo o que você precisa para se mover pelo
app, nesta ordem:

1. **Nova conversa** abre uma conversa vazia. O logo do AI Prism no topo faz
   o mesmo.
2. **Buscar conversas** abre a página de Histórico com a caixa de busca
   pronta.
3. **Suas conversas**, das mais novas para as mais antigas, agrupadas em Hoje,
   Ontem, Últimos 7 dias, Últimos 30 dias e Mais antigas. Selecione um título
   para abri-lo. Passe o mouse sobre uma linha, ou chegue até ela pelo teclado,
   para ver **Renomear** e **Excluir**.
4. **Sua conta e as Configurações**, no canto inferior esquerdo: o e-mail com
   que você entrou e a engrenagem que abre as Configurações. No celular é por
   ela que se chega às Configurações: a engrenagem fecha a barra lateral e as
   abre.

Enquanto a lista carrega, aparecem linhas cinza do mesmo tamanho, para que
nada pule quando as conversas chegam. Sem nenhuma conversa ainda, a lista
avisa e oferece **Começar a primeira conversa**.

### Barra lateral recolhida

No computador, a seta ao lado do logo recolhe a barra lateral em um trilho
estreito com as mesmas ações em ícones: expandir, Nova conversa, Buscar
conversas, Configurações e sua conta. Passe o mouse sobre um ícone para ver o
nome. A escolha fica salva neste navegador.

### No celular

No celular a barra lateral fica escondida. Abra pelo botão de menu no canto
superior esquerdo da tela. Enquanto ela está aberta:

- o resto da tela fica escurecido e não pode ser usado;
- o teclado fica dentro da barra lateral (Tab e Shift+Tab circulam por ela);
- **Esc**, o botão de fechar ou um toque na área escurecida a fecham, e você
  volta para onde estava.

A linha da conversa aberta mostra os botões Renomear e Excluir. Para renomear
ou excluir outras conversas, use a página de Histórico, onde todas as linhas
os mostram.

### Histórico

A página de Histórico lista todas as conversas e permite:

- **buscar por assunto**: a busca é semântica, então encontra uma conversa
  pelo tema, não só pelas palavras do título. Cada resultado mostra um
  percentual de correspondência. **Esc** ou o botão de limpar esvaziam a
  busca;
- **ordenar** das mais novas ou das mais antigas;
- **selecionar** conversas pelas caixas de seleção (ou **Selecionar tudo**) e
  excluí-las de uma vez;
- **renomear** ou **excluir** uma conversa pelos botões no fim da linha.

Quando a busca não encontra nada, a página sugere outras palavras e oferece
**Limpar busca**. Sem nenhuma conversa, oferece **Nova conversa**.

### Começando uma conversa

Uma conversa nova abre com uma saudação e algumas sugestões para começar:
fazer uma pergunta aos dados da empresa, criar uma apresentação, montar uma
planilha, redigir um documento, gerar uma imagem e ajuda para escrever. A
primeira sugestão fica em destaque como o ponto de partida mais útil.

Escolher uma sugestão preenche a caixa de mensagem com o começo de um pedido,
por exemplo "Crie uma apresentação de 6 slides sobre ", e deixa o cursor no
fim. Complete a frase e envie, ou ajuste antes.

Só aparecem as sugestões que funcionam nesta instalação: a sugestão de dados
precisa de uma ferramenta de dados (como o Genie One) que o administrador
permita e que esteja ligada no menu Ferramentas; a de imagem precisa de um
modelo de imagem e da ferramenta de imagem.

### Idioma e tema

A interface está disponível em inglês, português do Brasil e espanhol. Com o
idioma da interface em **Padrão (navegador)** (Configurações, Preferências),
o AI Prism segue o idioma do navegador. Se o navegador usar qualquer outro
idioma, a interface aparece em inglês.

Trocar entre os temas claro e escuro faz as cores mudarem suavemente em
200 ms. Se o sistema operacional estiver configurado para reduzir movimento,
a troca é instantânea.

### Teclado

| Tecla | Onde | O que faz |
|---|---|---|
| Tab / Shift+Tab | em qualquer lugar | Passa de um controle a outro; um anel de foco mostra onde você está |
| Esc | barra lateral no celular | Fecha a barra lateral |
| Esc | busca do Histórico | Limpa a busca |
| Esc | renomeando uma conversa | Cancela a renomeação |
| Enter | renomeando uma conversa | Salva o novo nome |
