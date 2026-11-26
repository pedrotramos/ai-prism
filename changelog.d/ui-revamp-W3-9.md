### Fixed

- **Trocar de conversa não perde mais edições não salvas de um estúdio.** Ao escolher outra conversa na barra lateral,
  abrir "Nova conversa" (inclusive dentro de um projeto, a partir da Home, de Projetos ou de Agentes), usar "Criar com
  Claude" ou voltar/avançar no navegador, qualquer estúdio com trabalho não salvo (apresentação em modo de edição ou
  documento) agora passa pelo próprio aviso Salvar / Descartar / Cancelar antes da navegação. Cancelar (ou um salvamento
  que falha) mantém a conversa, o rascunho e a URL como estavam; descartar ou salvar leva à conversa pedida. Estúdios sem
  alterações fecham sem aviso, como antes. No Voltar/Avançar do navegador, que não pode ser cancelado, a URL da conversa
  aberta é restaurada quando o trabalho é mantido.
