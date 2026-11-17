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
