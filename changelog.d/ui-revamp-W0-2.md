### Added

- **Marcas dos provedores de modelos** (base da revisão da interface). Nova biblioteca `providerMarks` e componentes
  `ProviderMark` e `McpMark`: cada modelo recebe a marca monocromática do seu provedor (Claude, OpenAI, Gemini,
  DeepSeek, Zhipu, Kimi, Qwen, Meta) desenhada em `currentColor`, e o MCP tem a sua. A marca vem do provedor cadastrado
  no catálogo e, para modelos sem provedor conhecido (por exemplo endpoints adicionados pelo administrador), do id do
  modelo; o que não casa recebe um ponto neutro. Sem título, a marca é decorativa (`aria-hidden`); com título, o nome
  do provedor é o rótulo acessível. Os caminhos SVG vêm do lobe-icons (MIT), creditados em `THIRD_PARTY_NOTICES.md`. Os
  três README ganham a linha de marcas registradas. Nenhuma tela usa os componentes ainda.
