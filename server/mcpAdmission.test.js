// Credential admission of MCP Services a user connects (W2-11c): every connect
// candidate that is not a catalog entry with a confirmed per-user/Databricks
// class goes through mcpCredentials classification, and anything that is not
// confirmed (shared, unverified, or a classifier error) is REFUSED — fail
// closed. The classifier is injected; no workspace, no database.
//
//   node --test server/mcpAdmission.test.js
import test from "node:test";
import assert from "node:assert/strict";

import {
  admitMcpConnection,
  mcpAdmissionError,
  resetMcpAdmissionCache,
  searchExternalMcpConnections,
} from "./externalMcp.ts";

const TOKEN = "fake-obo-token-not-a-secret";
const USER = "user@example.com";
const CURATED_SLACK = {
  connectionName: "system.ai.slack",
  source: "curated",
  hidden: false,
  credentialClass: "per_user",
};

function fakeClassifier(credentialClass, { calls = [] } = {}) {
  const fn = async (name, opts) => {
    calls.push({ name, opts });
    return {
      credentialClass,
      credentialType: credentialClass === "shared" ? "BEARER_TOKEN" : null,
    };
  };
  fn.calls = calls;
  return fn;
}

test.beforeEach(() => resetMcpAdmissionCache());

test("admitMcpConnection: a by-name service with a shared credential is refused", async () => {
  const classify = fakeClassifier("shared");
  const r = await admitMcpConnection(TOKEN, USER, "acme.tools.shared_svc", {
    catalog: [],
    classify,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "shared_credential");
  assert.equal(r.credentialClass, "shared");
  assert.equal(classify.calls.length, 1);
  assert.equal(classify.calls[0].name, "acme.tools.shared_svc");
});

test("admitMcpConnection: a by-name service with a per-user credential is admitted (no false positive)", async () => {
  const r = await admitMcpConnection(TOKEN, USER, "acme.tools.per_user_svc", {
    catalog: [],
    classify: fakeClassifier("per_user"),
  });
  assert.deepEqual(
    { ok: r.ok, credentialClass: r.credentialClass },
    { ok: true, credentialClass: "per_user" },
  );
  const d = await admitMcpConnection(TOKEN, USER, "acme.tools.obo_svc", {
    catalog: [],
    classify: fakeClassifier("databricks"),
  });
  assert.equal(d.ok, true);
});

test("admitMcpConnection: unverified metadata is refused (fail closed)", async () => {
  const r = await admitMcpConnection(TOKEN, USER, "acme.tools.opaque", {
    catalog: [],
    classify: fakeClassifier("unverified"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "credential_unverified");
});

test("admitMcpConnection: a classifier error is refused, not admitted (fail closed)", async () => {
  const classify = async () => {
    throw new Error("metadata read blew up");
  };
  const r = await admitMcpConnection(TOKEN, USER, "acme.tools.boom", {
    catalog: [],
    classify,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "credential_check_failed");
  // a classifier returning nothing is no better
  const empty = await admitMcpConnection(TOKEN, USER, "acme.tools.empty", {
    catalog: [],
    classify: async () => null,
  });
  assert.equal(empty.ok, false);
});

test("admitMcpConnection: a catalog lookup error still classifies, and a refusal stays a refusal", async () => {
  const catalog = async () => {
    throw new Error("db down");
  };
  const r = await admitMcpConnection(TOKEN, USER, "acme.tools.shared_svc", {
    catalog,
    classify: fakeClassifier("shared"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "shared_credential");
});

test("admitMcpConnection: a catalog entry with a confirmed class connects without reclassifying", async () => {
  const classify = fakeClassifier("shared");
  const r = await admitMcpConnection(TOKEN, USER, "system.ai.slack", {
    catalog: [CURATED_SLACK],
    classify,
  });
  assert.equal(r.ok, true);
  assert.equal(r.credentialClass, "per_user");
  assert.equal(classify.calls.length, 0);
});

test("admitMcpConnection: an unchecked custom catalog row is classified like a by-name service", async () => {
  const classify = fakeClassifier("shared");
  const row = {
    connectionName: "acme.tools.legacy",
    source: "custom",
    hidden: false,
    credentialClass: null,
  };
  const r = await admitMcpConnection(TOKEN, USER, "acme.tools.legacy", {
    catalog: [row],
    classify,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "shared_credential");
  assert.equal(classify.calls.length, 1);
});

test("admitMcpConnection: the user token goes to the classifier only as its OBO login check", async () => {
  const classify = fakeClassifier("per_user");
  await admitMcpConnection(TOKEN, USER, "acme.tools.per_user_svc", {
    catalog: [],
    classify,
  });
  assert.equal(classify.calls[0].opts.adminToken, TOKEN);
});

test("admitMcpConnection: a definitive class is cached briefly; an error is not", async () => {
  const classify = fakeClassifier("shared");
  await admitMcpConnection(TOKEN, USER, "acme.tools.cached", {
    catalog: [],
    classify,
  });
  await admitMcpConnection(TOKEN, USER, "acme.tools.cached", {
    catalog: [],
    classify,
  });
  assert.equal(classify.calls.length, 1);
  let n = 0;
  const failing = async () => {
    n++;
    throw new Error("transient");
  };
  await admitMcpConnection(TOKEN, USER, "acme.tools.flaky", {
    catalog: [],
    classify: failing,
  });
  await admitMcpConnection(TOKEN, USER, "acme.tools.flaky", {
    catalog: [],
    classify: failing,
  });
  assert.equal(n, 2);
});

test("mcpAdmissionError: a readable reason with a stable code, never a credential value", () => {
  for (const code of [
    "shared_credential",
    "credential_unverified",
    "credential_unchecked",
    "credential_check_failed",
  ]) {
    const e = mcpAdmissionError(code);
    assert.equal(e.code, `mcp_${code}`);
    assert.ok(e.error.length > 20, `readable message for ${code}`);
    assert.doesNotMatch(e.error, /BEARER_TOKEN|fake-obo-token|Bearer /);
  }
  assert.match(mcpAdmissionError("shared_credential").error, /compartilhada/);
});

test("searchExternalMcpConnections: a shared by-name candidate is listed as refused, with the reason", async () => {
  const items = await searchExternalMcpConnections(
    TOKEN,
    USER,
    "acme.tools.shared_svc",
    50,
    {
      catalog: [CURATED_SLACK],
      classify: fakeClassifier("shared"),
    },
  );
  const cand = items.find((i) => i.connectionName === "acme.tools.shared_svc");
  assert.ok(cand, "the typed name is still listed so the user sees why");
  assert.equal(cand.refused, "mcp_shared_credential");
  assert.match(cand.comment, /compartilhada/);
  assert.equal(
    items.find((i) => i.connectionName === "system.ai.slack").refused,
    undefined,
  );
});

test("searchExternalMcpConnections: a per-user by-name candidate is offered normally", async () => {
  const items = await searchExternalMcpConnections(
    TOKEN,
    USER,
    "acme.tools.per_user_svc",
    50,
    {
      catalog: [],
      classify: fakeClassifier("per_user"),
    },
  );
  assert.equal(items[0].connectionName, "acme.tools.per_user_svc");
  assert.equal(items[0].refused, undefined);
});

// W2-11a invariant 4: designating a shared-credential service as the web search
// backend (WEB_SEARCH_MCP_SERVICE) is a deployment setting for the native tool
// only. It must not admit that service on any user connect path.
test("admitMcpConnection: the designated web search service is still refused for users (W2-11a invariant 4)", async () => {
  const prev = process.env.WEB_SEARCH_MCP_SERVICE;
  process.env.WEB_SEARCH_MCP_SERVICE = "acme.search.firecrawl";
  try {
    const ws = await import("./webSearch/index.ts");
    assert.equal(
      ws.resolveWebSearchBackend().chain.find((c) => c.kind === "external-mcp")?.service,
      "acme.search.firecrawl",
    );
    const r = await admitMcpConnection(TOKEN, USER, "acme.search.firecrawl", {
      catalog: [],
      classify: fakeClassifier("shared"),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "shared_credential");
  } finally {
    if (prev === undefined) delete process.env.WEB_SEARCH_MCP_SERVICE;
    else process.env.WEB_SEARCH_MCP_SERVICE = prev;
  }
});
