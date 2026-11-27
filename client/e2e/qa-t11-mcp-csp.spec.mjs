import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const model = JSON.parse(fx.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages[1].model

test('QA T11 S3: opening an MCP App raises no enforced script-src violation', async ({ browser, baseURL }) => {
  const body = JSON.parse(fx.routes[`GET /api/sessions/${ids.s3}/messages`].body)
  body.messages = [
    body.messages[0],
    {
      id: '910',
      role: 'assistant',
      content: 'Here is the chart.\n\n{{toolcall:c1}}',
      attachments: null,
      model,
      prompt_tokens: 120,
      completion_tokens: 80,
      blocks: null,
      tool_calls: [{
        id: 'c1',
        name: 'mcp_chart__show_chart',
        label: 'Chart',
        args: { series: 'a' },
        status: 'ok',
        durationMs: 120,
        result: 'chart ready',
        hasUi: true,
        uiServiceName: 'main.apps.chart',
        uiToolCallId: '501',
        uiCsp: { connectDomains: ['https://api.example.com'], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      }],
      created_at: '2026-11-22T07:09:00.000Z',
      media_processing: null,
      intent_classify: null,
      reasoning: null,
    },
  ]
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  try {
    await ctx.addInitScript(() => {
      const add = (v) => { window.__csp = window.__csp || []; window.__csp.push(v) }
      if (window === window.top) window.addEventListener('message', (e) => { if (e.data?.__cspProbe) add(e.data.v) })
      document.addEventListener('securitypolicyviolation', (e) => {
        const v = { directive: e.effectiveDirective, disposition: e.disposition, blocked: e.blockedURI }
        if (window === window.top) add(v)
        else window.top.postMessage({ __cspProbe: 1, v }, '*')
      }, true)
    })
    const page = await ctx.newPage()
    await page.route(`**/api/sessions/${ids.s3}/messages`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    )
    await page.goto(`${baseURL}/#/chat/${ids.s3}`)
    await page.getByRole('button', { name: /Open app/i }).first().click()
    await expect(page.frameLocator('iframe[data-mcp-app]').locator('#status')).toHaveText('ready')
    const enforced = await page.evaluate(() =>
      (window.__csp || []).filter((v) => v.directive.startsWith('script-src') && v.disposition === 'enforce')
    )
    expect(enforced).toEqual([])
  } finally {
    await ctx.close()
  }
})
