import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.mjs";

const authenticatedEnv = {
  AUTH_STORE: {
    idFromName: () => "auth-store",
    get: () => ({
      fetch: async () => Response.json({ user: { id: "synthetic-user", role: "membre" } }),
    }),
  },
  SEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

async function send(payload) {
  const originalFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: 200, data: { results: [] } }));
  };
  try {
    const response = await worker.fetch(new Request("https://redtrace.test/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }), authenticatedEnv);
    return { status: response.status, body: await response.json(), sent };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("convertit jour, mois et année en date_naissance complète", async () => {
  const { status, sent } = await send({ jour_naissance: 4, mois_naissance: 6, annee_naissance: 1990 });
  assert.equal(status, 200);
  assert.equal(sent.date_naissance, "1990-06-04");
  assert.equal("jour_naissance" in sent, false);
  assert.equal("mois_naissance" in sent, false);
  assert.equal("annee_naissance" in sent, false);
});

test("convertit une année seule en date_naissance partielle", async () => {
  const { status, sent } = await send({ annee_naissance: 1990, mois_naissance: 6 });
  assert.equal(status, 200);
  assert.equal(sent.date_naissance, "1990-06");
});

test("refuse un jour de naissance sans mois", async () => {
  const { status, body, sent } = await send({ jour_naissance: 14, annee_naissance: 1990 });
  assert.equal(status, 400);
  assert.match(body.error, /mois de naissance/i);
  assert.equal(sent, null);
});

test("refuse de combiner date_naissance et entiers de naissance", async () => {
  const { status, body } = await send({ date_naissance: "1990-06-04", annee_naissance: 1990 });
  assert.equal(status, 400);
  assert.match(body.error, /pas les deux/i);
});
