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

test("register, login, session lookup, and logout work end-to-end", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kikzxw-auth-test-"));
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: projectRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, AUTH_USER: "", AUTH_PASS: "" },
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

  const post = (route, body, cookie) => fetch(`${url}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const credentials = { username: "analyste_test", password: "motdepasse-test-42" };

  const registration = await post("/api/auth/register", credentials);
  const registered = await registration.json();
  assert.equal(registration.status, 201);
  assert.equal(registered.user.username, "AnalysteTest");
  assert.equal(registered.user.role, "admin");
  assert.equal(registered.firstUser, true);
  const registrationCookie = registration.headers.get("set-cookie")?.split(";")[0];
  assert.ok(registrationCookie);

  const duplicate = await post("/api/auth/register", credentials);
  assert.equal(duplicate.status, 409);

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
