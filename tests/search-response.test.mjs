import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.mjs";

const validQuery = { prenom: "Ada" };
const originalFetch = globalThis.fetch;

function createEnv({ sessionStatus = 200, rateLimitSuccess = true } = {}) {
  return {
    AUTH_STORE: {
      idFromName: () => "auth-store",
      get: () => ({
        fetch: async () => Response.json(
          sessionStatus === 200
            ? { user: { id: "synthetic-user", role: "membre" } }
            : { error: "Session inactive ou expirée." },
          { status: sessionStatus },
        ),
      }),
    },
    SEARCH_RATE_LIMITER: { limit: async () => ({ success: rateLimitSuccess }) },
    ASSETS: { fetch: () => new Response("asset") },
  };
}

async function requestSearch(fetchImplementation, payload = validQuery, envOptions) {
  globalThis.fetch = fetchImplementation;
  try {
    return await worker.fetch(new Request("https://redtrace.test/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.15" },
      body: JSON.stringify(payload),
    }), createEnv(envOptions));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("relays a valid SearchHub JSON response", async () => {
  const response = await requestSearch(async () => new Response(
    JSON.stringify({
      status: 200,
      data: { results: [{ prenom: "Ada" }] },
      meta: { total: 1, page: 1, pages: 1 },
    }),
    { headers: { "Content-Type": "application/json" } },
  ));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.results, [{ prenom: "Ada" }]);
});

test("accepts a UTF-8 BOM before an otherwise valid JSON response", async () => {
  const response = await requestSearch(async () => new Response(
    `\uFEFF${JSON.stringify({ data: { results: [] } })}`,
  ));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.results, []);
});

test("returns a clear JSON error for an empty upstream response", async () => {
  const response = await requestSearch(async () => new Response(null, { status: 204 }));

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /réponse vide/i);
});

test("returns a clear JSON error for malformed upstream JSON", async () => {
  const response = await requestSearch(async () => new Response("<html>upstream error</html>"));

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /JSON illisible/i);
});

test("rejects valid JSON with an unexpected top-level shape", async () => {
  const response = await requestSearch(async () => new Response(JSON.stringify([])));

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /JSON inattendue/i);
});

test("rejects responses larger than the configured limit", async () => {
  const body = " ".repeat(8 * 1024 * 1024 + 1);
  const response = await requestSearch(async () => new Response(body));

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /dépasse la taille autorisée/i);
});

test("does not contact SearchHub when the search has no criteria", async () => {
  let called = false;
  const response = await requestSearch(async () => {
    called = true;
    return new Response("{}");
  }, { page: 1 });

  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("rejects search without a valid session before contacting SearchHub", async () => {
  let called = false;
  const response = await requestSearch(async () => {
    called = true;
    return new Response("{}");
  }, validQuery, { sessionStatus: 401 });

  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("returns a retry hint when the Cloudflare search binding denies a request", async () => {
  let called = false;
  const response = await requestSearch(async () => {
    called = true;
    return new Response("{}");
  }, validQuery, { rateLimitSuccess: false });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(called, false);
});

test("fails closed when the Cloudflare search rate-limit binding is missing", async () => {
  const response = await worker.fetch(new Request("https://redtrace.test/api/search", {
    method: "POST",
    headers: { Cookie: "rt_session=synthetic", "Content-Type": "application/json" },
    body: JSON.stringify(validQuery),
  }), {
    AUTH_STORE: {
      idFromName: () => "auth-store",
      get: () => ({ fetch: async () => Response.json({ user: { id: "synthetic-user" } }) }),
    },
  });

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /limitation de débit/i);
});

test("rejects methods other than POST without contacting SearchHub", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}");
  };
  try {
    const response = await worker.fetch(new Request("https://redtrace.test/api/search"), {});
    assert.equal(response.status, 405);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adds security and cache headers to static assets and keeps unknown API routes out of assets", async () => {
  let assetFetches = 0;
  const env = {
    ASSETS: {
      fetch: async () => {
        assetFetches += 1;
        return new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
      },
    },
  };
  const page = await worker.fetch(new Request("https://redtrace.test/"), env);
  assert.equal(page.headers.get("Content-Security-Policy")?.includes("frame-ancestors 'none'"), true);
  assert.equal(page.headers.get("Content-Security-Policy")?.includes("https://cdn.jsdelivr.net"), true);
  assert.equal(page.headers.get("X-Frame-Options"), "DENY");
  assert.equal(page.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(page.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(page.headers.get("Cache-Control"), "no-cache");

  const unknownApi = await worker.fetch(new Request("https://redtrace.test/api/not-a-real-route"), env);
  assert.equal(unknownApi.status, 404);
  assert.equal(assetFetches, 1);
});
