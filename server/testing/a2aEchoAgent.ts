// A tiny A2A 1.0 agent used by the tests (a local fake A2A server) and, bundled, by the "ai-prism-a2a-echo" example
// app (docs/a2a.md, "Try it with the echo agent"). It speaks JSON-RPC at /a2a, serves its card at
// /.well-known/agent-card.json and answers by echoing the message, with a few trigger words so a client can be
// exercised end to end:
//
//   (any text)        task submitted -> working -> artifact "Echo: <text>" (chunked when streaming) -> completed
//   "input needed"    the task stops in input_required; the next message on it completes with "Thanks: <text>"
//   "fail"            the task ends failed with a status message
//   "slow"            the task stays working for ~20 s unless cancelled (CancelTask)
//
// `verifyBearer` makes the agent require `Authorization: Bearer <token>` on every request (card included unless
// `publicCard`); a request that fails it is answered 401 with `WWW-Authenticate: Bearer`. Every request's method,
// path and authorization header is recorded in `requests` so a test can prove which credential went where.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { DefaultRequestHandler, AgentEvent } from '@a2a-js/sdk/server'
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server'
import { InMemoryTaskStore } from '@a2a-js/sdk/server'
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express'
import { AgentCard as AgentCardCodec, TaskState, Role } from '@a2a-js/sdk'
import type { AgentCard, Part, Message } from '@a2a-js/sdk'

export interface EchoAgentOptions {
  host?: string
  port?: number
  name?: string
  /** declare streaming in the card (the client then uses SendStreamingMessage) */
  streaming?: boolean
  /** require this check on every request; false answers 401 */
  verifyBearer?: (token: string) => boolean
  /** serve the card without the bearer even when verifyBearer is set */
  publicCard?: boolean
  /** the public base URL the card advertises (defaults to the listening address) */
  baseUrl?: string
}

export interface EchoAgent {
  url: string
  cardUrl: string
  requests: { method: string; path: string; authorization: string | null; extra: Record<string, string> }[]
  /** task ids the agent was asked to cancel */
  cancelled: string[]
  close: () => Promise<void>
}

const text = (value: string): Part => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' })
const now = () => new Date().toISOString()

const userText = (m: Message): string =>
  (m.parts || [])
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join(' ')
    .trim()

function status(state: TaskState, say?: string) {
  const message: Message | undefined = say
    ? { messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_AGENT, parts: [text(say)], metadata: undefined, extensions: [], referenceTaskIds: [] }
    : undefined
  return { state, message, timestamp: now() }
}

export function createEchoExecutor(cancelled: string[] = []): AgentExecutor {
  const stopped = new Set<string>()
  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus) {
      const { taskId, contextId } = ctx
      const input = userText(ctx.userMessage)
      const publishStatus = (state: TaskState, say?: string) => bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(state, say), metadata: undefined }))
      const publishArtifact = (chunk: string, append: boolean, lastChunk: boolean) =>
        bus.publish(
          AgentEvent.artifactUpdate({
            taskId,
            contextId,
            artifact: { artifactId: 'echo', name: 'echo', description: '', parts: [text(chunk)], metadata: undefined, extensions: [] },
            append,
            lastChunk,
            metadata: undefined,
          })
        )
      // the first event of every call is the task (an existing one is replaced by the same id)
      bus.publish(AgentEvent.task({ id: taskId, contextId, status: status(TaskState.TASK_STATE_SUBMITTED), artifacts: [], history: [], metadata: undefined }))
      publishStatus(TaskState.TASK_STATE_WORKING)

      if (/\bfail\b/i.test(input)) {
        publishStatus(TaskState.TASK_STATE_FAILED, 'The echo agent was asked to fail.')
        bus.finished()
        return
      }
      if (/\bslow\b/i.test(input)) {
        for (let i = 0; i < 200 && !stopped.has(taskId); i++) await new Promise((r) => setTimeout(r, 100))
        if (stopped.has(taskId)) {
          publishStatus(TaskState.TASK_STATE_CANCELED)
          bus.finished()
          return
        }
      }
      if (/input needed/i.test(input) && !ctx.task?.history?.length) {
        publishStatus(TaskState.TASK_STATE_INPUT_REQUIRED, 'What should I echo?')
        bus.finished()
        return
      }
      const reply = ctx.task && /input needed/i.test(JSON.stringify(ctx.task.history || [])) ? `Thanks: ${input}` : `Echo: ${input}`
      const mid = Math.ceil(reply.length / 2)
      publishArtifact(reply.slice(0, mid), false, false)
      publishArtifact(reply.slice(mid), true, true)
      publishStatus(TaskState.TASK_STATE_COMPLETED)
      bus.finished()
    },
    async cancelTask(taskId: string, bus: ExecutionEventBus) {
      cancelled.push(taskId)
      stopped.add(taskId)
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId: '', status: status(TaskState.TASK_STATE_CANCELED), metadata: undefined }))
      bus.finished()
    },
  }
}

export async function startEchoAgent(opts: EchoAgentOptions = {}): Promise<EchoAgent> {
  const host = opts.host || '127.0.0.1'
  const requests: EchoAgent['requests'] = []
  const cancelled: string[] = []
  const app = express()
  let base = opts.baseUrl || ''

  const card = (): AgentCard => ({
    name: opts.name || 'AI Prism Echo Agent',
    description: 'Echoes what it is sent. Used to try A2A agents in AI Prism.',
    supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    provider: { organization: 'AI Prism', url: 'https://example.com' },
    version: '1.0.0',
    documentationUrl: undefined,
    capabilities: { streaming: opts.streaming !== false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: opts.verifyBearer ? { bearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { description: '', scheme: 'Bearer', bearerFormat: '' } } } } : {},
    securityRequirements: opts.verifyBearer ? [{ schemes: { bearer: { list: [] } } }] : [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Repeats the message back.', tags: ['echo', 'demo'], examples: ['Say hello'], inputModes: [], outputModes: [], securityRequirements: [] }],
    signatures: [],
    iconUrl: undefined,
  })

  app.use((req: Request, res: Response, next: NextFunction) => {
    const authorization = (req.headers.authorization as string | undefined) ?? null
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-') && typeof v === 'string') extra[k] = v
    requests.push({ method: req.method, path: req.path, authorization, extra })
    const isCard = req.path === '/.well-known/agent-card.json'
    if (opts.verifyBearer && !(isCard && opts.publicCard)) {
      const token = /^Bearer (.+)$/i.exec(authorization || '')?.[1]
      if (!token || !opts.verifyBearer(token)) {
        res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' })
        return
      }
    }
    next()
  })
  // the card in its ProtoJSON wire form (what the A2A 1.0 spec says an agent serves)
  app.get('/.well-known/agent-card.json', (_req, res) => void res.json(AgentCardCodec.toJSON(card())))
  const handler = new DefaultRequestHandler(card(), new InMemoryTaskStore(), createEchoExecutor(cancelled))
  app.use('/a2a', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }))

  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(opts.port || 0, host, resolve))
  const port = (server.address() as AddressInfo).port
  base = opts.baseUrl || `http://${host}:${port}`
  const url = base
  return {
    url,
    cardUrl: `${url}/.well-known/agent-card.json`,
    requests,
    cancelled,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections?.(), server.close(() => resolve()))),
  }
}
