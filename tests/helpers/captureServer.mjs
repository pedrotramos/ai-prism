// A loopback "attacker" listener for egress tests: counts every request it gets and answers a 1x1 PNG (so a
// request that does reach it is a real, loadable image). Binds 127.0.0.1 on a random port; the caller starts it
// and stops it by handle (`await cap.close()`). Nothing here talks to a real network.
import http from 'node:http'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export async function startCaptureServer({ host = '127.0.0.1' } = {}) {
  const hits = []
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url })
    // CORS-open so a fetch() that reaches it is not hidden by the browser's own check
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'content-length': PNG.length })
    res.end(req.method === 'HEAD' ? undefined : PNG)
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const origin = `http://${host}:${server.address().port}`
  return {
    origin,
    hits: () => hits.slice(),
    count: () => hits.length,
    reset: () => void (hits.length = 0),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
