### Security

- **Um SVG armazenado não executa mais script quando aberto como página (md-exfil T12).** `GET /api/images/:id` devolvia o
  tipo de conteúdo guardado, então um SVG aberto em navegação de nível superior (ou em outra aba) rodava o `<script>` na
  origem do app, com a sessão do usuário. Agora toda rota que devolve bytes guardados ou gerados (a imagem e as
  exportações `.pptx`, `.docx`, `.md` e `.xlsx`) envia `Content-Security-Policy: default-src 'none'; img-src 'self' data:;
  style-src 'unsafe-inline'; sandbox`, `X-Content-Type-Options: nosniff` e `Content-Disposition: attachment` para tudo que
  não seja imagem raster (PNG, JPEG, GIF, WebP, AVIF, BMP). Uma imagem raster continua inline, porque o app a carrega
  como `<img>`, que nunca executa script de SVG. O tipo de conteúdo continua correto e os downloads mantêm o nome.
  Um único auxiliar (`server/artifactHeaders.ts`) é aplicado por rota; o shell do app e os frames de MCP Apps
  (`buildViewCsp`) não mudam.
