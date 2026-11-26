### Fixed

- **Testes e2e estáveis em máquinas lentas (CI).** Quatro testes dependiam de tempo: o da barra lateral recolhida
  agora afasta o ponteiro do trilho antes de verificar que o painel está recolhido; o das ferramentas usa uma política
  simulada com estado (a aba relê a política depois de salvar); o do gráfico espera as cores das barras serem pintadas;
  e o do editor de slides repete as leituras enquanto o iframe é substituído. Nenhum código do produto muda.
