### Fixed

- **Trocar de conversa não perde mais edições não salvas de um estúdio.** Ao escolher outra conversa na barra lateral,
  abrir "Nova conversa" (inclusive dentro de um projeto, a partir da Home, de Projetos ou de Agentes), usar "Criar com
  Claude" ou voltar/avançar no navegador, qualquer estúdio com trabalho não salvo (apresentação em modo de edição ou
  documento) agora passa pelo próprio aviso Salvar / Descartar / Cancelar antes da navegação. Cancelar (ou um salvamento
  que falha) mantém a conversa, o rascunho e a URL como estavam; descartar ou salvar leva à conversa pedida. Estúdios sem
  alterações fecham sem aviso, como antes. No Voltar/Avançar do navegador, que não pode ser cancelado, a URL da conversa
  aberta é restaurada quando o trabalho é mantido.

- **Planilha: uma edição de IA aceita e ainda não salva também passa pelo aviso.** Se o salvamento falhou (ou ainda está em
  andamento), trocar de conversa abre Salvar / Descartar edição / Continuar editando, em vez de perder a edição que só
  existia na prévia. Dois ajustes na mesma navegação protegida: um segundo Voltar do navegador com o aviso aberto mantém a
  URL da conversa em tela e segue o destino do primeiro quando a pessoa decide, e escolher a conversa que já está aberta
  não pergunta nada.
