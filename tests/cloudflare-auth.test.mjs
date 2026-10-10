import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.mjs";

function createAuthBinding(onFetch) {
  return {
    idFromName(name) {
      assert.equal(name, "kikzxw-account-store");
      return name;
    },
    get(id) {
      assert.equal(id, "kikzxw-account-store");
      return { fetch: onFetch };
    },
  };
}

test("routes registration to the persistent auth store and returns its session cookie", async () => {
  let forwardedRequest;
  const response = await worker.fetch(new Request("https://kikzxw.test/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.25",
    },
    body: JSON.stringify({ username: "test-user", password: "correct-horse" }),
  }), {
    AUTH_STORE: createAuthBinding(async (request) => {
      forwardedRequest = request;
      return Response.json(
        { user: { id: "user-1", username: "TestUser", role: "admin" } },
        { status: 201, headers: { "Set-Cookie": "rt_session=session-token; HttpOnly" } },
      );
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Set-Cookie"), "rt_session=session-token; HttpOnly");
  assert.equal(new URL(forwardedRequest.url).pathname, "/api/auth/register");
  assert.equal(forwardedRequest.headers.get("CF-Connecting-IP"), "203.0.113.25");
  assert.deepEqual(await forwardedRequest.json(), { username: "test-user", password: "correct-horse" });
});

test("forwards the browser session cookie when checking the current account", async () => {
  let forwardedRequest;
  const response = await worker.fetch(new Request("https://kikzxw.test/api/auth/me", {
    headers: { Cookie: "rt_session=abc123" },
  }), {
    AUTH_STORE: createAuthBinding(async (request) => {
      forwardedRequest = request;
      return Response.json({ user: { id: "user-1", username: "TestUser", role: "admin" } });
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(forwardedRequest.headers.get("Cookie"), "rt_session=abc123");
});

test("reports missing Cloudflare account storage instead of falling through to static assets", async () => {
  const response = await worker.fetch(new Request("https://kikzxw.test/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "test-user", password: "correct-horse" }),
  }), {
    ASSETS: { fetch: () => new Response("unexpected asset fallback") },
  });

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /authentification n'est pas configurée/i);
});

test("rejects oversized auth payloads before forwarding them to storage", async () => {
  let forwarded = false;
  const response = await worker.fetch(new Request("https://kikzxw.test/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ payload: "x".repeat(5 * 1024) }),
  }), {
    AUTH_STORE: createAuthBinding(async () => {
      forwarded = true;
      return Response.json({});
    }),
  });

  assert.equal(response.status, 413);
  assert.equal(forwarded, false);
});
