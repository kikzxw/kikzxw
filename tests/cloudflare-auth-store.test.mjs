import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { AuthStore } from "../src/worker.mjs";

globalThis.crypto ??= webcrypto;

function createSqlStorage() {
  const users = [];
  const sessions = [];
  const limits = new Map();
  const settings = new Map();
  const cursor = (rows = []) => ({
    toArray: () => rows,
    one: () => rows[0],
  });

  const sql = {
    exec(statement, ...values) {
      const query = statement.replace(/\s+/g, " ").trim();
      if (query.startsWith("CREATE ")) return cursor();
      if (query.startsWith("ALTER ")) return cursor(); // migration simulée
      if (query === "SELECT value FROM settings WHERE key = ?") {
        return cursor(settings.has(values[0]) ? [{ value: settings.get(values[0]) }] : []);
      }
      if (query.startsWith("INSERT INTO settings")) {
        settings.set(values[0], values[1]);
        return cursor();
      }
      if (query === "DELETE FROM auth_rate_limits WHERE window_started_at <= ? AND bucket != ?") {
        for (const [bucket, row] of limits) {
          if (row.window_started_at <= values[0] && bucket !== values[1]) limits.delete(bucket);
        }
        return cursor();
      }
      if (query === "SELECT window_started_at, attempts FROM auth_rate_limits WHERE bucket = ?") {
        const row = limits.get(values[0]);
        return cursor(row ? [{ ...row }] : []);
      }
      if (query.startsWith("INSERT INTO auth_rate_limits")) {
        const previous = limits.get(values[0]);
        const expired = previous && previous.window_started_at <= values[2];
        limits.set(values[0], {
          window_started_at: expired ? values[1] : previous?.window_started_at ?? values[1],
          attempts: expired ? 1 : (previous?.attempts || 0) + 1,
        });
        return cursor();
      }
      if (query === "SELECT id FROM users WHERE username = ? COLLATE NOCASE") {
        return cursor(users.filter((user) => user.username.toLowerCase() === values[0].toLowerCase()));
      }
      if (query === "SELECT COUNT(*) AS count FROM users") return cursor([{ count: users.length }]);
      if (query.startsWith("INSERT INTO users")) {
        const [id, username, salt, password_hash, role, created_at] = values;
        users.push({ id, username, salt, password_hash, role, created_at, search_count: 0, suspended: 0, email: null, lang: null, timezone: null, datefmt: null });
        return cursor();
      }
      if (query === "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)") {
        const [token_hash, user_id, expires_at] = values;
        sessions.push({ token_hash, user_id, expires_at });
        return cursor();
      }
      if (query.startsWith("DELETE FROM sessions WHERE expires_at <= ?")) {
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
          if (sessions[index].expires_at <= values[0]) sessions.splice(index, 1);
        }
        return cursor();
      }
      if (query.startsWith("SELECT id, username, salt, password_hash, role, created_at, search_count, suspended, email, lang, timezone, datefmt FROM users WHERE username = ? COLLATE NOCASE")) {
        return cursor(users.filter((user) => user.username.toLowerCase() === values[0].toLowerCase()));
      }
      if (query.startsWith("SELECT ") && query.includes(" FROM users WHERE id = ?")) {
        const user = users.find((entry) => entry.id === values[0]);
        if (!user) return cursor();
        const selected = query.slice("SELECT ".length, query.indexOf(" FROM users WHERE id = ?"))
          .split(",").map((column) => column.trim());
        return cursor([Object.fromEntries(selected.map((column) => [column, user[column]]))]);
      }
      if (query.startsWith("UPDATE users SET ")) {
        const user = users.find((entry) => entry.id === values.at(-1));
        if (!user) return cursor();
        const columns = query.slice("UPDATE users SET ".length, query.indexOf(" WHERE id = ?"))
          .split(",").map((part) => part.trim().split(" = ")[0]);
        columns.forEach((column, index) => { user[column] = values[index]; });
        return cursor();
      }
      if (query.includes("FROM sessions JOIN users")) {
        const session = sessions.find((entry) => entry.token_hash === values[0] && entry.expires_at > values[1]);
        const user = users.find((entry) => entry.id === session?.user_id);
        return cursor(user && !user.suspended ? [{
          id: user.id,
          username: user.username,
          role: user.role,
          created_at: user.created_at,
          search_count: user.search_count,
          suspended: user.suspended,
          email: user.email,
          lang: user.lang,
          timezone: user.timezone,
          datefmt: user.datefmt,
        }] : []);
      }
      if (query.startsWith("UPDATE sessions SET expires_at = ?")) {
        const session = sessions.find((entry) => entry.token_hash === values[1]);
        if (session) session.expires_at = values[0];
        return cursor();
      }
      if (query === "DELETE FROM sessions WHERE token_hash = ?") {
        const index = sessions.findIndex((entry) => entry.token_hash === values[0]);
        if (index >= 0) sessions.splice(index, 1);
        return cursor();
      }
      if (query === "DELETE FROM sessions WHERE user_id = ?") {
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
          if (sessions[index].user_id === values[0]) sessions.splice(index, 1);
        }
        return cursor();
      }
      if (query === "DELETE FROM saved_searches WHERE user_id = ?") return cursor();
      if (query === "DELETE FROM users WHERE id = ?") {
        const index = users.findIndex((user) => user.id === values[0]);
        if (index >= 0) users.splice(index, 1);
        return cursor();
      }
      throw new Error(`Unexpected SQL in test double: ${query}`);
    },
  };

  return { sql };
}

function createContext() {
  const storage = createSqlStorage();
  return {
    storage,
    blockConcurrencyWhile: (callback) => callback(),
  };
}

test("SQLite-backed auth store registers, authenticates, resumes, and logs out without KV transactions", async () => {
  const store = new AuthStore(createContext(), { ADMIN_BOOTSTRAP_TOKEN: "synthetic-bootstrap-token" });
  const makeRegister = (username, bootstrapToken) => new Request("https://auth.internal/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.42" },
    body: JSON.stringify({
      username,
      password: "cloud-test-password",
      ...(bootstrapToken ? { bootstrapToken } : {}),
    }),
  });
  const missingBootstrapToken = await store.fetch(makeRegister("cloud-user"));
  assert.equal(missingBootstrapToken.status, 403);

  const invalidBootstrapToken = await store.fetch(makeRegister("cloud-user", "wrong-token"));
  assert.equal(invalidBootstrapToken.status, 403);

  const register = await store.fetch(makeRegister("cloud-user", "synthetic-bootstrap-token"));
  const registered = await register.json();
  const cookie = register.headers.get("Set-Cookie")?.split(";")[0];

  assert.equal(register.status, 201);
  assert.equal(registered.user.username, "CloudUser");
  assert.equal(registered.user.role, "admin");
  assert.ok(cookie);

  const duplicate = await store.fetch(makeRegister("CLOUD-USER"));
  assert.equal(duplicate.status, 409);

  const member = await store.fetch(makeRegister("second-user"));
  assert.equal(member.status, 201);
  assert.equal((await member.json()).user.role, "membre");

  const currentSession = await store.fetch(new Request("https://auth.internal/api/auth/me", {
    headers: { Cookie: cookie },
  }));
  assert.equal(currentSession.status, 200);
  assert.equal((await currentSession.json()).user.id, registered.user.id);

  const updateProfile = await store.fetch(new Request("https://auth.internal/api/user/profile", {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", lang: "fr", timezone: "Europe/Paris", datefmt: "ISO" }),
  }));
  assert.equal(updateProfile.status, 200);
  assert.equal((await updateProfile.json()).user.email, "admin@example.com");
  const rejectedProfile = await store.fetch(new Request("https://auth.internal/api/user/profile", {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "partial@example.com", lang: "invalid" }),
  }));
  assert.equal(rejectedProfile.status, 400);
  const refreshedProfile = await store.fetch(new Request("https://auth.internal/api/auth/me", { headers: { Cookie: cookie } }));
  assert.equal((await refreshedProfile.clone().json()).user.email, "admin@example.com");
  const refreshedPayload = await refreshedProfile.json();
  assert.equal(refreshedPayload.user.timezone, "Europe/Paris");

  const invalidSettings = await store.fetch(new Request("https://auth.internal/api/admin/settings", {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ registrationOpen: false, loginMode: "invalid" }),
  }));
  assert.equal(invalidSettings.status, 400);
  const unchangedSettings = await store.fetch(new Request("https://auth.internal/api/admin/settings", {
    headers: { Cookie: cookie },
  }));
  assert.equal((await unchangedSettings.json()).registrationOpen, true);

  const passwordChange = await store.fetch(new Request("https://auth.internal/api/user/password", {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: "cloud-test-password", newPassword: "cloud-new-password" }),
  }));
  assert.equal(passwordChange.status, 200);

  const logout = await store.fetch(new Request("https://auth.internal/api/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie },
  }));
  assert.equal(logout.status, 200);

  const login = await store.fetch(new Request("https://auth.internal/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.42" },
    body: JSON.stringify({ username: "cloud-user", password: "cloud-new-password" }),
  }));
  assert.equal(login.status, 200);
  const loginCookie = login.headers.get("Set-Cookie")?.split(";")[0];
  const deleteAccount = await store.fetch(new Request("https://auth.internal/api/user/account", {
    method: "DELETE",
    headers: { Cookie: loginCookie, "X-Forwarded-Proto": "https" },
  }));
  assert.equal(deleteAccount.status, 200);
  assert.match(deleteAccount.headers.get("Set-Cookie"), /Max-Age=0/);

  const invalidatedSession = await store.fetch(new Request("https://auth.internal/api/auth/me", {
    headers: { Cookie: loginCookie },
  }));
  assert.equal(invalidatedSession.status, 401);
});

test("refuses to create the first Cloudflare account when no bootstrap secret is configured", async () => {
  const store = new AuthStore(createContext());
  const response = await store.fetch(new Request("https://auth.internal/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.43" },
    body: JSON.stringify({ username: "first-user", password: "cloud-test-password" }),
  }));

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ADMIN_BOOTSTRAP_TOKEN/);
});
