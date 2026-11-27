### Fixed

- **Testes e2e estáveis em máquinas lentas (CI), segunda rodada.** O teste do painel de slides ancorado (1440 px) espera a
  barra lateral recolher antes de clicar ao lado do painel (antes o clique caía numa conversa da barra e navegava), e todas
  as leituras do slide no editor de design passam por um leitor que tolera a troca do iframe. Nenhum código do produto muda.
