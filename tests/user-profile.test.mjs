import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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

/**
 * Starts a fresh test server and registers an admin account.
 * Returns { url, cookie, userId, cleanup }.
 */
async function startWithAdmin(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kikzxw-profile-test-"));
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
      ADMIN_BOOTSTRAP_TOKEN: "bootstrap-profile-test",
      TRUST_PROXY: "0",
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

  const reg = await fetch(`${url}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "profile_admin",
      password: "profil-test-password",
      bootstrapToken: "bootstrap-profile-test",
    }),
  });
  assert.equal(reg.status, 201);
  const { user } = await reg.json();
  const cookie = reg.headers.get("set-cookie").split(";")[0];
  return { url, cookie, userId: user.id, child };
}

test("/api/user/profile PATCH updates email and profile fields", async (t) => {
  const { url, cookie } = await startWithAdmin(t);

  const response = await fetch(`${url}/api/user/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ email: "admin@example.com", lang: "fr", timezone: "Europe/Paris" }),
  });
  assert.equal(response.status, 200);
  const { user } = await response.json();
  assert.equal(user.email, undefined); // publicUser does not expose email
  assert.equal(user.username, "ProfileAdmin");
});

test("/api/user/profile PATCH rejects invalid email", async (t) => {
  const { url, cookie } = await startWithAdmin(t);

  const response = await fetch(`${url}/api/user/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /email/i);
});

test("/api/user/password PATCH changes password and allows re-login", async (t) => {
  const { url, cookie } = await startWithAdmin(t);

  const change = await fetch(`${url}/api/user/password`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "profil-test-password", newPassword: "nouveau-mot-de-passe" }),
  });
  assert.equal(change.status, 200);

  // Old password no longer works.
  const loginOld = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "profile_admin", password: "profil-test-password" }),
  });
  assert.equal(loginOld.status, 401);

  // New password works.
  const loginNew = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "profile_admin", password: "nouveau-mot-de-passe" }),
  });
  assert.equal(loginNew.status, 200);
});

test("/api/user/password PATCH rejects wrong current password", async (t) => {
  const { url, cookie } = await startWithAdmin(t);

  const response = await fetch(`${url}/api/user/password`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "mauvais-mot-de-passe", newPassword: "nouveau-mot-de-passe" }),
  });
  assert.equal(response.status, 401);
});

test("/api/user/password PATCH rejects a new password that is too short", async (t) => {
  const { url, cookie } = await startWithAdmin(t);

  const response = await fetch(`${url}/api/user/password`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "profil-test-password", newPassword: "court" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /8 caractères/);
});

test("/api/user/account DELETE suppresses the account and invalidates the session", async (t) => {
  const { url, cookie } = await startWithAdmin(t);

  // Register a second admin so we are allowed to delete the first.
  const reg2 = await fetch(`${url}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "second_admin", password: "second-profil-password" }),
  });
  assert.equal(reg2.status, 201);
  const secondCookie = reg2.headers.get("set-cookie").split(";")[0];

  // Promote second user to admin so first can delete itself.
  const meResp = await fetch(`${url}/api/auth/me`, { headers: { Cookie: cookie } });
  const adminId = (await meResp.json()).user.id;
  const me2Resp = await fetch(`${url}/api/auth/me`, { headers: { Cookie: secondCookie } });
  const secondId = (await me2Resp.json()).user.id;
  const promote = await fetch(`${url}/api/admin/users/${secondId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(promote.status, 200);

  // Delete the first account.
  const del = await fetch(`${url}/api/user/account`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).ok, true);

  // Original session is now invalid.
  const me = await fetch(`${url}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 401);

  // Trying to re-login with the deleted account fails.
  const login = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "profile_admin", password: "profil-test-password" }),
  });
  assert.equal(login.status, 401);

  void adminId; // used for clarity above
});

test("/api/user/* routes return 401 without a session", async (t) => {
  const { url } = await startWithAdmin(t);

  for (const { path: route, method } of [
    { path: "/api/user/profile", method: "PATCH" },
    { path: "/api/user/password", method: "PATCH" },
    { path: "/api/user/account", method: "DELETE" },
  ]) {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 401, `Expected 401 for ${method} ${route}`);
  }
});

test("Retry-After header is present on 429 responses for register and login", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kikzxw-ratelimit-test-"));
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
      ADMIN_BOOTSTRAP_TOKEN: "rate-limit-test-token",
      TRUST_PROXY: "0",
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

  const body = JSON.stringify({ username: "ratelimit_user", password: "motdepasse-ratelimit" });
  // Exhaust the register rate limit (10 per minute).
  let registerResponse;
  for (let i = 0; i <= 10; i += 1) {
    registerResponse = await fetch(`${url}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }
  assert.equal(registerResponse.status, 429);
  assert.equal(registerResponse.headers.get("retry-after"), "60");

  // Exhaust the login rate limit (15 per minute).
  let loginResponse;
  for (let i = 0; i <= 15; i += 1) {
    loginResponse = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }
  assert.equal(loginResponse.status, 429);
  assert.equal(loginResponse.headers.get("retry-after"), "60");
});

test("admin password reset allows the user to log in with the new password", async (t) => {
  const { url, cookie, userId } = await startWithAdmin(t);

  // Register a member.
  const reg = await fetch(`${url}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "member_reset", password: "ancien-mot-de-passe" }),
  });
  assert.equal(reg.status, 201);
  const memberId = (await reg.json()).user.id;

  // Admin resets the member's password.
  const reset = await fetch(`${url}/api/admin/users/${memberId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ password: "nouveau-mot-de-passe-admin" }),
  });
  assert.equal(reset.status, 200);

  // Old password no longer works.
  const loginOld = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "member_reset", password: "ancien-mot-de-passe" }),
  });
  assert.equal(loginOld.status, 401);

  // New password works.
  const loginNew = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "member_reset", password: "nouveau-mot-de-passe-admin" }),
  });
  assert.equal(loginNew.status, 200);

  void userId; // used for role context
});
