// The user's MCP connect paths (W2-11c): connecting (catalog entry or typed
// by-name service) and re-checking a saved connection both run the credential
// admission, so a service that calls its backend with ONE shared credential is
// refused with a readable reason and never adopted. Identity, DB and the
// gateway probe are injected; no database, no workspace.
//
//   node --test server/routes/mcpConnections.test.js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import registerMcpConnectionRoutes from "./mcpConnections.js";
import { admitMcpConnection, resetMcpAdmissionCache } from "../externalMcp.ts";

const USER = "user@example.com";
const FAKE_TOKEN = "fake-obo-token-not-a-secret";

function fakeAuth(req, res, next) {
  req.email = USER;
  req.token = FAKE_TOKEN;
  next();
}

// classes by service name; anything not listed makes the classifier throw
const CLASSES = {
  "acme.tools.shared_svc": "shared",
  "acme.tools.per_user_svc": "per_user",
};

async function serve() {
  resetMcpAdmissionCache();
  const calls = { adopt: [], status: [], probe: [] };
  const classify = async (name) => {
    if (!CLASSES[name]) throw new Error("metadata unreadable");
    return { credentialClass: CLASSES[name], credentialType: null };
  };
  const app = express();
  app.use(express.json());
  registerMcpConnectionRoutes(app, {
    auth: fakeAuth,
    ensureReady: async () => {},
    getHiddenMcpNames: async () => new Set(),
    admitMcpConnection: (token, email, name) =>
      admitMcpConnection(token, email, name, { catalog: [], classify }),
    probeMcpConnection: async (token, name) => {
      calls.probe.push(name);
      return { status: "connected" };
    },
    adoptUserMcpConnection: async (email, token, name, comment, status) =>
      calls.adopt.push({ name, status }),
    setUserMcpStatus: async (email, token, name, status) =>
      calls.status.push({ name, status }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path) => {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: r.status, body: await r.json() };
  };
  return { post, calls, close: () => new Promise((r) => server.close(r)) };
}

test("POST /api/mcp/connections/:name refuses a shared-credential service and never adopts it", async () => {
  const s = await serve();
  try {
    const r = await s.post("/api/mcp/connections/acme.tools.shared_svc");
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "mcp_shared_credential");
    assert.match(r.body.error, /compartilhada/);
    assert.doesNotMatch(JSON.stringify(r.body), /fake-obo-token/);
    assert.equal(s.calls.adopt.length, 0);
    assert.equal(s.calls.probe.length, 0);
  } finally {
    await s.close();
  }
});

test("POST /api/mcp/connections/:name still connects a per-user service", async () => {
  const s = await serve();
  try {
    const r = await s.post("/api/mcp/connections/acme.tools.per_user_svc");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(s.calls.adopt, [
      { name: "acme.tools.per_user_svc", status: "connected" },
    ]);
  } finally {
    await s.close();
  }
});

test("POST /api/mcp/connections/:name fails closed when classification errors", async () => {
  const s = await serve();
  try {
    const r = await s.post("/api/mcp/connections/acme.tools.unknown_svc");
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "mcp_credential_check_failed");
    assert.equal(s.calls.adopt.length, 0);
  } finally {
    await s.close();
  }
});

test("POST /api/mcp/connections/:name/probe refuses a saved shared-credential connection and marks it", async () => {
  const s = await serve();
  try {
    const r = await s.post("/api/mcp/connections/acme.tools.shared_svc/probe");
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "mcp_shared_credential");
    assert.equal(s.calls.probe.length, 0);
    assert.deepEqual(s.calls.status, [
      { name: "acme.tools.shared_svc", status: "forbidden" },
    ]);
  } finally {
    await s.close();
  }
});

test("POST /api/mcp/connections/:name/probe still probes a per-user service", async () => {
  const s = await serve();
  try {
    const r = await s.post(
      "/api/mcp/connections/acme.tools.per_user_svc/probe",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "connected");
    assert.deepEqual(s.calls.probe, ["acme.tools.per_user_svc"]);
  } finally {
    await s.close();
  }
});

test("GET /api/tools/mcp/external/search (tool picker) never offers a refused by-name service", async () => {
  const { default: registerToolsSearchRoutes } =
    await import("./toolsSearch.js");
  const { searchExternalMcpConnections } = await import("../externalMcp.ts");
  resetMcpAdmissionCache();
  const app = express();
  registerToolsSearchRoutes(app, {
    auth: fakeAuth,
    searchExternalMcpConnections: (token, email, q) =>
      searchExternalMcpConnections(token, email, q, 50, {
        catalog: [],
        classify: async (name) => ({
          credentialClass: CLASSES[name] || "unverified",
        }),
      }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const shared = await (
      await fetch(
        `${base}/api/tools/mcp/external/search?q=acme.tools.shared_svc`,
      )
    ).json();
    assert.equal(
      shared.results.some((r) => r.connectionName === "acme.tools.shared_svc"),
      false,
    );
    const ok = await (
      await fetch(
        `${base}/api/tools/mcp/external/search?q=acme.tools.per_user_svc`,
      )
    ).json();
    assert.equal(ok.results[0].connectionName, "acme.tools.per_user_svc");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// The settings listing warms the per-turn tool cache for adopted connections.
// That warm-up opens an MCP session (initialize + tools/list), so it must never
// run for a connection refused by admission or saved as forbidden. Outbound
// fetch is mocked: any request to the gateway's MCP path is a contact.
// (Ported from QA round 1, .megabrain/parity-ux/review/qa-w2-11c-r1.md.)
async function listingWithMockedGateway(
  { name, credentialClass, savedStatus: initial },
  run,
) {
  const realFetch = globalThis.fetch;
  const originalHost = process.env.DATABRICKS_HOST;
  const gatewayRequests = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/ai-gateway/mcp-services/")) gatewayRequests.push(url);
    throw new Error("mock outbound request");
  };
  process.env.DATABRICKS_HOST = "https://workspace.invalid";
  resetMcpAdmissionCache();
  const state = { savedStatus: initial };
  const classify = async () => ({ credentialClass });
  const { searchExternalMcpConnections } = await import("../externalMcp.ts");
  const app = express();
  registerMcpConnectionRoutes(app, {
    auth: fakeAuth,
    ensureReady: async () => {},
    getHiddenMcpNames: async () => new Set(),
    admitMcpConnection: (token, email, n) =>
      admitMcpConnection(token, email, n, { catalog: [], classify }),
    searchExternalMcpConnections: (token, email, query) =>
      searchExternalMcpConnections(token, email, query, 50, {
        catalog: [],
        classify,
      }),
    listUserMcpConnections: async () => [
      { connectionName: name, comment: "", status: state.savedStatus },
    ],
    setUserMcpStatus: async (_e, _t, _n, status) => {
      state.savedStatus = status;
    },
    probeMcpConnection: async () => ({ status: "connected" }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({
      state,
      gatewayRequests,
      post: (path) => realFetch(`${base}${path}`, { method: "POST" }),
      list: async (q) => {
        const r = await realFetch(`${base}/api/mcp/connections?q=${q}`);
        const body = await r.json();
        // the warm-up is fire-and-forget after the response
        await new Promise((resolve) => setTimeout(resolve, 20));
        return body;
      },
    });
  } finally {
    await new Promise((r) => server.close(r));
    globalThis.fetch = realFetch;
    if (originalHost === undefined) delete process.env.DATABRICKS_HOST;
    else process.env.DATABRICKS_HOST = originalHost;
    resetMcpAdmissionCache();
  }
}

test("GET /api/mcp/connections never contacts a saved connection refused on re-check", async () => {
  const name = "acme.tools.shared_saved";
  await listingWithMockedGateway(
    { name, credentialClass: "shared", savedStatus: "connected" },
    async ({ state, gatewayRequests, post, list }) => {
      const refusal = await post(`/api/mcp/connections/${name}/probe`);
      assert.equal(refusal.status, 403);
      assert.equal(state.savedStatus, "forbidden");
      const body = await list(name);
      const row = body.connections.find((c) => c.connectionName === name);
      assert.equal(row?.status, "forbidden");
      assert.equal(row?.refused, "mcp_shared_credential");
      assert.match(row?.comment || "", /compartilhada/);
      assert.equal(
        gatewayRequests.length,
        0,
        `refused service was contacted: ${gatewayRequests[0]}`,
      );
    },
  );
});

test("GET /api/mcp/connections never contacts a refused connection still saved as connected", async () => {
  // adopted before the rule existed, never re-checked: the search refusal alone must stop the warm-up
  const name = "acme.tools.shared_legacy";
  await listingWithMockedGateway(
    { name, credentialClass: "shared", savedStatus: "connected" },
    async ({ gatewayRequests, list }) => {
      const body = await list(name);
      assert.equal(
        body.connections.find((c) => c.connectionName === name)?.refused,
        "mcp_shared_credential",
      );
      assert.equal(
        gatewayRequests.length,
        0,
        `refused service was contacted: ${gatewayRequests[0]}`,
      );
    },
  );
});

test("GET /api/mcp/connections still warms an admitted per-user connection (no false positive)", async () => {
  const name = "acme.tools.per_user_saved";
  await listingWithMockedGateway(
    { name, credentialClass: "per_user", savedStatus: "connected" },
    async ({ gatewayRequests, list }) => {
      const body = await list(name);
      assert.equal(
        body.connections.find((c) => c.connectionName === name)?.refused,
        undefined,
      );
      assert.ok(gatewayRequests.length >= 1, "admitted connection is warmed");
    },
  );
});
