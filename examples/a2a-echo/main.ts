// Entry point of the example "ai-prism-a2a-echo" Databricks App: the tiny A2A 1.0 echo agent used by the tests
// (server/testing/a2aEchoAgent.ts), served on the port the Apps runtime gives it. Bundled to one file by deploy.sh;
// the Apps proxy authenticates every caller (the user's token, as an app-to-app on-behalf-of call) before a request
// reaches this process, so the agent itself holds no credential.
import { startEchoAgent } from '../../server/testing/a2aEchoAgent.ts'

const port = Number(process.env.DATABRICKS_APP_PORT || process.env.PORT || 8000)
// the card advertises the App's public URL; the runtime provides it (https://<name>-<workspace id>.<n>.<cloud>.databricksapps.com)
const baseUrl = String(process.env.DATABRICKS_APP_URL || '').replace(/\/+$/, '') || undefined

startEchoAgent({ host: '0.0.0.0', port, streaming: true, name: 'AI Prism echo agent', ...(baseUrl ? { baseUrl } : {}) }).then(
  (agent) => console.log(`a2a echo agent listening on ${port}, card at ${agent.cardUrl}`),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
