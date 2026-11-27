### Security

- Segurança: o modelo não consegue mais usar o `web_fetch` para vazar dados numa URL. A ferramenta só abre endereços que o usuário digitou ou que uma busca na web listou; qualquer outro volta como `url_not_in_prior_context`, sem abrir conexão, e a tentativa fica no log (`egress_blocked`, só o host). URLs com credencial (`token=`, `key=`, usuário:senha@) só passam se estiverem na mensagem do usuário.
- Segurança: toda resposta (chat, continuar, regenerar e agentes agendados) agora leva a regra de nunca embutir dados da conversa numa URL, e imagens externas na resposta são registradas no log (só o host).
- Segurança: texto extraído de arquivos e transcrições anexados não autoriza mais o `web_fetch`; só o que o usuário digitou (antes do delimitador de anexos) conta, também no histórico reaproveitado em continuar, regenerar e agentes.
