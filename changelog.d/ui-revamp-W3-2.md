### Fixed

- **Preferências**: o título "Padrões para novas conversas" aparecia duas vezes; fica só o da seção de padrões (h3), e a ordem dos títulos volta a passar no axe. O padrão do modelo de imagem continua logo abaixo, com o seu próprio rótulo.
- **Estúdio de planilhas**: números, percentuais e as estatísticas da seleção (Soma, Média, Mín, Máx) agora seguem o idioma da interface (en, pt, es) em vez de sempre usar o formato pt-BR; "Sum: 208,2" vira "Sum: 208.2" em uma interface em inglês. O .xlsx exportado não muda.
- **Estúdio de planilhas**: a nota do rodapé descreve o arquivo baixado e agora chama a aba exatamente como ela aparece nele ("Instruções de Uso", em qualquer idioma da interface), usando a mesma constante da exportação.
- **Estúdio de planilhas**: o botão Exportar fica desativado, com uma dica explicando o motivo (en, pt, es), enquanto uma alteração aceita está sendo salva; assim o arquivo baixado e a nota do rodapé sempre falam da mesma aba.
- **Estúdio de planilhas**: o Exportar também fica desativado durante "Tentar de novo" após uma falha ao salvar (o salvamento passou a marcar o estado ocupado em um só lugar, para o primeiro Aceitar e para a nova tentativa).
