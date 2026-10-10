import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${url}/api/auth/me`);
      if (response.status === 401) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Test server did not start.");
}

test("register, login, session lookup, and logout work end-to-end", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kikzxw-auth-test-"));
  const port = await unusedPort();
  const upstreamPort = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  let upstreamSearches = 0;
  const upstream = createHttpServer((request, response) => {
    if (request.method === "POST" && request.url === "/synthetic-search") {
      upstreamSearches += 1;
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: 200, data: { results: [{ prenom: "Synthetic" }] } }));
      return;
    }
    response.writeHead(404).end();
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      AUTH_USER: "",
      AUTH_PASS: "",
      ADMIN_BOOTSTRAP_TOKEN: "synthetic-bootstrap-token",
      TRUST_PROXY: "0",
      RATE_LIMIT_SEARCH: "1",
      SEARCH_ENDPOINT: `http://127.0.0.1:${upstreamPort}/synthetic-search`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    upstream.close();
    await once(upstream, "close");
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitForServer(url, child).catch((error) => {
    throw new Error(`${error.message} ${stderr}`);
  });

  const post = (route, body, cookie, forwardedProto) => fetch(`${url}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(forwardedProto ? { "X-Forwarded-Proto": forwardedProto } : {}),
    },
    body: JSON.stringify(body),
  });
  const credentials = { username: "analyste_test", password: "motdepasse-test-42" };

  const missingBootstrapToken = await post("/api/auth/register", credentials);
  assert.equal(missingBootstrapToken.status, 403);
  const noSessionSearch = await post("/api/search", { prenom: "Synthetic" });
  assert.equal(noSessionSearch.status, 401);
  assert.equal(upstreamSearches, 0);

  const registration = await post("/api/auth/register", {
    ...credentials,
    bootstrapToken: "synthetic-bootstrap-token",
  }, undefined, "https");
  const registered = await registration.json();
  assert.equal(registration.status, 201);
  assert.equal(registered.user.username, "AnalysteTest");
  assert.equal(registered.user.role, "admin");
  assert.equal(registered.firstUser, true);
  assert.doesNotMatch(registration.headers.get("set-cookie"), /;\s*Secure(?:;|$)/i);
  const registrationCookie = registration.headers.get("set-cookie")?.split(";")[0];
  assert.ok(registrationCookie);

  const duplicate = await post("/api/auth/register", credentials);
  assert.equal(duplicate.status, 409);

  const memberRegistration = await post("/api/auth/register", {
    username: "membre_test",
    password: "motdepasse-test-42",
  });
  assert.equal(memberRegistration.status, 201);
  assert.equal((await memberRegistration.json()).user.role, "membre");
  const memberCookie = memberRegistration.headers.get("set-cookie")?.split(";")[0];

  const memberAdminAccess = await fetch(`${url}/api/admin/users`, { headers: { Cookie: memberCookie } });
  assert.equal(memberAdminAccess.status, 403);
  const unauthenticatedAdminAccess = await fetch(`${url}/api/admin/users`);
  assert.equal(unauthenticatedAdminAccess.status, 401);
  const authorizedAdminAccess = await fetch(`${url}/api/admin/users`, { headers: { Cookie: registrationCookie } });
  assert.equal(authorizedAdminAccess.status, 200);
  assert.equal((await authorizedAdminAccess.json()).users.length, 2);

  const search = await post("/api/search", { prenom: "Synthetic" }, registrationCookie);
  assert.equal(search.status, 200);
  assert.equal(upstreamSearches, 1);
  const quotaExceeded = await post("/api/search", { prenom: "Synthetic" }, registrationCookie);
  assert.equal(quotaExceeded.status, 429);
  assert.equal(quotaExceeded.headers.get("retry-after"), "60");
  assert.equal(upstreamSearches, 1);

  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("cache-control"), "no-cache");
  const indexPage = await fetch(`${url}/index.html`);
  assert.equal(indexPage.headers.get("cache-control"), "no-cache");
  const missingFile = await fetch(`${url}/package.json`);
  assert.equal(missingFile.status, 404);
  assert.equal(missingFile.headers.get("x-frame-options"), "DENY");

  const currentSession = await fetch(`${url}/api/auth/me`, { headers: { Cookie: registrationCookie } });
  assert.equal(currentSession.status, 200);
  assert.equal((await currentSession.json()).user.id, registered.user.id);

  const logout = await post("/api/auth/logout", {}, registrationCookie);
  assert.equal(logout.status, 200);
  const expiredSession = await fetch(`${url}/api/auth/me`, { headers: { Cookie: registrationCookie } });
  assert.equal(expiredSession.status, 401);

  const badLogin = await post("/api/auth/login", { ...credentials, password: "mauvais-mot-de-passe" });
  assert.equal(badLogin.status, 401);
  const login = await post("/api/auth/login", credentials);
  const loggedIn = await login.json();
  assert.equal(login.status, 200);
  assert.equal(loggedIn.user.id, registered.user.id);
  assert.ok(login.headers.get("set-cookie"));
});

test("sets Secure cookies only for HTTPS requests identified directly or through a trusted proxy", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kikzxw-proxy-cookie-test-"));
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      AUTH_USER: "",
      AUTH_PASS: "",
      ADMIN_BOOTSTRAP_TOKEN: "synthetic-bootstrap-token",
      TRUST_PROXY: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitForServer(url, child).catch((error) => {
    throw new Error(`${error.message} ${stderr}`);
  });

  const credentials = { username: "proxy_admin", password: "synthetic-password-42" };
  const registration = await fetch(`${url}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
    body: JSON.stringify({ ...credentials, bootstrapToken: "synthetic-bootstrap-token" }),
  });
  assert.equal(registration.status, 201);
  const registrationCookie = registration.headers.get("set-cookie");
  assert.match(registrationCookie, /;\s*Secure(?:;|$)/i);

  const logout = await fetch(`${url}/api/auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: registrationCookie.split(";")[0],
      "X-Forwarded-Proto": "https",
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /;\s*Secure(?:;|$)/i);

  const login = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "http" },
    body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200);
  assert.doesNotMatch(login.headers.get("set-cookie"), /;\s*Secure(?:;|$)/i);
});

test("refuses first-account registration when no bootstrap secret is configured", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kikzxw-bootstrap-test-"));
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      AUTH_USER: "",
      AUTH_PASS: "",
      ADMIN_BOOTSTRAP_TOKEN: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitForServer(url, child).catch((error) => {
    throw new Error(`${error.message} ${stderr}`);
  });

  const response = await fetch(`${url}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "synthetic-user", password: "synthetic-password" }),
  });

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ADMIN_BOOTSTRAP_TOKEN/);
});
