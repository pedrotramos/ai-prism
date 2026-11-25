### Changed

- **A nova interface funciona como um app só, em 1440 e em 390 px.** A tela inicial passa a mostrar o seletor de
  projeto, o campo de mensagem centralizado e as conversas recentes; a barra do topo mostra o projeto como
  caminho, o botão do painel de artefatos e "Compartilhar". Compartilhar (no deck e na barra do topo) coloca a
  conversa em um projeto e abre os membros; uma conversa que já está num projeto vai direto aos membros. Cada
  projeto tem uma só cor, derivada do id, na tela inicial, na barra lateral e nas telas de projetos. Em larguras
  de 768 a 1100 px o painel do deck ganha um fundo escurecido que fecha ao clique e com Esc, devolvendo o foco.
  Em Configurações > Preferências aparecem o modelo e as ferramentas com que uma nova conversa começa e a
  velocidade da leitura em voz alta. Toda tela tem um único título de página (`h1`), e o teste de acessibilidade
  cobre também projetos, agentes e custos.

### Fixed

- **O estilo de resposta confirmado não volta para "Padrão" ao reabrir a conversa.** Depois de sair de uma
  conversa e voltar, o app lia o estilo de uma lista carregada no início; agora o estilo que o servidor aceitou
  é gravado nessa lista (um salvamento que falha não a altera).
- **Alvos de toque pequenos:** o nome do projeto na barra lateral tem no mínimo 24 px de altura, e o botão de
  anexar imagem do painel de IA tem 44 px no celular.
