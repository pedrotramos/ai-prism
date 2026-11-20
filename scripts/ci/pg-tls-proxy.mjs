#!/usr/bin/env node
// Local bridge between the Postgres suites and a Lakebase endpoint (ephemeral branch job).
//
// Three facts about Lakebase that the suites (server/isolation.test.js and
// server/rls.test.js: `ssl: false`, loopback PGHOST, one PGPASSWORD for every role)
// do not expect, verified on a real endpoint:
//   1. TLS is mandatory                        -> the bridge speaks SSLRequest + TLS upstream
//   2. the only login is the OAuth token       -> clients send a throwaway PGPASSWORD; the
//      (native password login is disabled)        bridge swaps in the token (PG_PROXY_TOKEN)
//   3. a role created by SQL cannot log in     -> a client that logs in as role X is mapped
//                                                 to the owner identity with `-c role=X`
//      (and the creator needs SET on it)       -> every session also gets
//                                                 `-c createrole_self_grant=set,inherit`
// A session mapped to X runs as X (current_user = X, X's rolbypassrls applies), so the
// suites exercise the real policies as a NOBYPASSRLS role.
//
//   PG_PROXY_OWNER=<identity> PG_PROXY_TOKEN=<token> \
//     node scripts/ci/pg-tls-proxy.mjs <upstream-host> [upstream-port=5432] [listen-port=0]
//
// Prints `listening <port>` on stdout once ready. Credentials only come from the
// environment and are never logged.
import net from 'node:net'
import tls from 'node:tls'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])
const SSL_CODE = 80877103
const CANCEL_CODE = 80877102
const PROTO3 = 196608

/** Parses a v3 StartupMessage into [key, value] pairs. */
export function parseStartup(buf) {
  const parts = buf.subarray(8, buf.length - 1).toString('utf8').split('\0')
  const out = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push([parts[i], parts[i + 1]])
  return out
}

export function buildStartup(pairs) {
  const body = Buffer.from(pairs.map(([k, v]) => `${k}\0${v}\0`).join('') + '\0', 'utf8')
  const head = Buffer.alloc(8)
  head.writeInt32BE(8 + body.length, 0)
  head.writeInt32BE(PROTO3, 4)
  return Buffer.concat([head, body])
}

/** Maps a client's startup to the owner identity (see 3. above). Pure, unit tested. */
export function rewriteStartup(buf, owner) {
  const pairs = parseStartup(buf)
  const get = (k) => pairs.find(([key]) => key === k)?.[1]
  const asRole = get('user')
  const opts = [get('options'), '-c createrole_self_grant=set,inherit']
  const rest = pairs.filter(([k]) => k !== 'user' && k !== 'options')
  if (asRole && asRole !== owner) opts.push(`-c role=${asRole}`)
  return buildStartup([['user', owner], ...rest, ['options', opts.filter(Boolean).join(' ')]])
}

/** Replaces a PasswordMessage ('p') by one carrying the token. */
export function passwordMessage(token) {
  const body = Buffer.from(`${token}\0`, 'utf8')
  const head = Buffer.alloc(5)
  head.write('p', 0, 'latin1')
  head.writeInt32BE(4 + body.length, 1)
  return Buffer.concat([head, body])
}

export function startProxy({ host, upstreamPort = 5432, listenPort = 0, owner, token }) {
  const server = net.createServer((client) => {
    client.pause()
    const raw = net.connect(upstreamPort, host)
    const drop = () => {
      client.destroy()
      raw.destroy()
    }
    raw.on('error', drop)
    client.on('error', drop)
    raw.once('connect', () => raw.write(SSL_REQUEST))
    raw.once('data', (b) => {
      if (b.toString('latin1', 0, 1) !== 'S') return drop()
      const up = tls.connect({ socket: raw, servername: host })
      up.on('error', drop)
      up.on('close', drop)
      client.on('close', drop)
      up.once('secureConnect', () => {
        up.pipe(client)
        let buf = Buffer.alloc(0)
        let state = 'startup' // startup -> password -> pipe
        const pump = () => {
          for (;;) {
            if (state === 'pipe') {
              if (buf.length) up.write(buf)
              buf = Buffer.alloc(0)
              return
            }
            if (buf.length < 8 && state === 'startup') return
            if (state === 'startup') {
              const len = buf.readInt32BE(0)
              if (buf.length < len) return
              const msg = buf.subarray(0, len)
              buf = buf.subarray(len)
              const code = msg.readInt32BE(4)
              if (code === SSL_CODE) {
                client.write('N')
              } else if (code === CANCEL_CODE) {
                up.write(msg)
                state = 'pipe'
              } else {
                up.write(rewriteStartup(msg, owner))
                state = 'password'
              }
            } else {
              if (buf.length < 5) return
              const len = buf.readInt32BE(1)
              if (buf.length < 1 + len) return
              const type = String.fromCharCode(buf[0])
              const msg = buf.subarray(0, 1 + len)
              buf = buf.subarray(1 + len)
              up.write(type === 'p' ? passwordMessage(token) : msg)
              state = 'pipe'
            }
          }
        }
        client.on('data', (d) => {
          buf = Buffer.concat([buf, d])
          pump()
        })
        client.resume()
      })
    })
  })
  return new Promise((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve(server)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [host, upstreamPort = '5432', listenPort = '0'] = process.argv.slice(2)
  const { PG_PROXY_OWNER: owner, PG_PROXY_TOKEN: token } = process.env
  if (!host || !owner || !token) {
    process.stderr.write('usage: PG_PROXY_OWNER=.. PG_PROXY_TOKEN=.. pg-tls-proxy.mjs <upstream-host> [upstream-port] [listen-port]\n')
    process.exit(2)
  }
  const server = await startProxy({ host, upstreamPort: Number(upstreamPort), listenPort: Number(listenPort), owner, token })
  process.stdout.write(`listening ${server.address().port}\n`)
}
