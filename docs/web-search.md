# Busca e leitura da web

O AI Prism oferece duas tools nativas aos modelos:

- `web_search`: encontra páginas e retorna título, URL e snippet.
- `web_fetch`: abre uma URL pública e retorna o conteúdo real em texto legível.

As credenciais pertencem ao deployment, não aos usuários. Portanto, nenhum
cliente precisa criar uma conta ou contratar individualmente o provedor de
busca.

## Configuração

Configure uma das fontes abaixo. A primeira disponível nesta ordem é usada:

### Brave Search central

```env
BRAVE_SEARCH_API_KEY=<chave mantida pelo operador do AI Prism>
WEB_SEARCH_DISABLED=0
```

### SearXNG próprio

O endpoint precisa habilitar respostas JSON em `/search?format=json`.

```env
SEARXNG_URL=https://search.example.com
WEB_SEARCH_DISABLED=0
```

### MCP legado

Continua suportado como backend de `web_search`. A leitura das páginas é feita
diretamente pelo `web_fetch` nativo.

```env
WEB_SEARCH_CONNECTION=web_search_mcp
WEB_SEARCH_DISABLED=0
```

`WEB_SEARCH_DISABLED=1` remove ambas as tools imediatamente.

## Segurança e limites

O downloader aceita apenas HTTP/HTTPS, resolve e fixa o endereço IP antes da
conexão, bloqueia redes privadas/loopback/link-local, revalida redirects e
rejeita redirects entre hosts quando há credenciais. Cada página tem timeout,
limite de redirects, limite de download e limite de texto devolvido ao modelo.

Nesta primeira versão são lidos HTML, texto e JSON. PDFs, páginas que exigem
login, CAPTCHA e sites que dependem exclusivamente de renderização JavaScript
retornam um erro explícito; eles podem receber um fallback de navegador isolado
em uma evolução posterior.
