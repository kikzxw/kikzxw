import { SearchResponseError, parseSearchResponse } from "./search-response.mjs";

const SEARCH_ENDPOINT = atob("aHR0cHM6Ly9hcGkuYnJpeGh1Yi5ydS9hcGkvdjEvc2VhcmNo");
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_SEARCH_SIZE = 16 * 1024;
const TEXT_FIELDS = [
  "nom_famille", "prenom",
  "date_naissance", "ville_naissance", "genre",
  "email", "telephone", "nom_utilisateur", "adresse_ip",
  "adresse", "code_postal", "ville",
  "steam_id", "fivem_license", "fivem_license2", "discord_id",
  "xbox_live_id", "live_id",
  "nir", "iban", "bic", "vin_plaque",
];
const INTEGER_FIELDS = {
  annee_naissance: [1800, 2100],
  jour_naissance: [1, 31],
  mois_naissance: [1, 12],
  page: [1, 100000],
  per_page: [1, 100],
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' https://cdn.jsdelivr.net; style-src 'self'; font-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function jsonResponse(status, payload) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

function secureResponse(response, cacheControl) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const AUTH_STORE_NAME = "kikzxw-account-store";
const SESSION_COOKIE = "rt_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,24}$/;
const encoder = new TextEncoder();

function authStore(env) {
  if (!env.AUTH_STORE) return null;
  return env.AUTH_STORE.get(env.AUTH_STORE.idFromName(AUTH_STORE_NAME));
}

function authUnavailable() {
  return jsonResponse(503, { error: "L'authentification n'est pas configurée sur ce déploiement." });
}

async function handleAuth(request, env) {
  const store = authStore(env);
  if (!store) return authUnavailable();

  const url = new URL(request.url);
  const headers = new Headers();
  const cookie = request.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) headers.set("CF-Connecting-IP", clientIp);
  headers.set("X-Forwarded-Proto", url.protocol.slice(0, -1));

  let body;
  if (request.method !== "GET") {
    const text = await request.text();
    if (encoder.encode(text).byteLength > 4 * 1024) {
      return jsonResponse(413, { error: "La requête d'authentification dépasse la taille autorisée." });
    }
    body = text;
    headers.set("Content-Type", request.headers.get("Content-Type") || "application/json");
  }

  const internalRequest = new Request(`https://auth.internal${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body,
  });
  return store.fetch(internalRequest);
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  return new Uint8Array(value.match(/.{2}/g).map((part) => Number.parseInt(part, 16)));
}

async function hashPassword(password, salt) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    material,
    256,
  );
  return new Uint8Array(bits);
}

async function hashSession(token) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function newToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function sessionFromRequest(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})(?:;|$)`).exec(cookie);
  return match?.[1] || null;
}

function displayUsername(username) {
  return username.split(/[^a-z0-9]+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("") || username;
}

function authJson(status, payload, headers = {}) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers },
  });
}

export class AuthStore {
  constructor(ctx, env = {}) {
    this.ctx = ctx;
    this.env = env;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'membre')),
          created_at TEXT NOT NULL,
          search_count INTEGER NOT NULL DEFAULT 0,
          suspended INTEGER NOT NULL DEFAULT 0
        )`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL
        )`,
      );
      sql.exec("CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)");
      sql.exec(
        `CREATE TABLE IF NOT EXISTS auth_rate_limits (
          bucket TEXT PRIMARY KEY,
          window_started_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL
        )`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS saved_searches (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`,
      );
      // Migration for accounts created before the suspension switch existed.
      try {
        sql.exec("ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0");
      } catch {
        // Column already present — nothing to migrate.
      }
    });
  }

  // ---- Platform settings ------------------------------------------------

  readSetting(key, fallback) {
    const row = this.ctx.storage.sql.exec(
      "SELECT value FROM settings WHERE key = ?",
      key,
    ).toArray()[0];
    if (!row) return fallback;
    try {
      const parsed = JSON.parse(row.value);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  writeSetting(key, value) {
    this.ctx.storage.sql.exec(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  getSettings() {
    return {
      registrationOpen: this.readSetting("registrationOpen", true) !== false,
      loginMode: ["all", "admins", "closed"].includes(this.readSetting("loginMode", "all"))
        ? this.readSetting("loginMode", "all")
        : "all",
      searchEnabled: this.readSetting("searchEnabled", true) !== false,
      notice: String(this.readSetting("notice", "") || "").slice(0, 200),
    };
  }

  updateSettings(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw Object.assign(new Error("Les réglages doivent être un objet JSON valide."), { status: 400 });
    }
    const current = this.getSettings();
    for (const [key, value] of Object.entries(body)) {
      if (!(key in current)) continue; // ignore unknown keys
      if (key === "notice") {
        if (typeof value !== "string") throw Object.assign(new Error("Le message d'annonce doit être du texte."), { status: 400 });
        this.writeSetting(key, value.slice(0, 200));
        continue;
      }
      if (key === "loginMode") {
        if (!["all", "admins", "closed"].includes(value)) {
          throw Object.assign(new Error("Mode de connexion invalide (attendu : all, admins ou closed)."), { status: 400 });
        }
        this.writeSetting(key, value);
        continue;
      }
      if (typeof value !== "boolean") {
        throw Object.assign(new Error(`Le réglage « ${key} » doit être un booléen.`), { status: 400 });
      }
      this.writeSetting(key, value);
    }
    return this.getSettings();
  }

  async fetch(request) {
    await this.ready;
    try {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/auth/register" && request.method === "POST") {
        const limited = await this.checkRateLimit(request, "register", 10);
        return limited || this.register(request);
      }
      if (pathname === "/api/auth/login" && request.method === "POST") {
        const limited = await this.checkRateLimit(request, "login", 15);
        return limited || this.login(request);
      }
      if (pathname === "/api/auth/me" && request.method === "GET") return this.currentUser(request);
      if (pathname === "/api/auth/logout" && request.method === "POST") return this.logout(request);
      if (pathname === "/api/auth/search-count" && request.method === "POST") return this.incrementSearchCount(request);
      if (pathname === "/api/settings" && request.method === "GET") return authJson(200, this.getSettings());
      if (pathname === "/api/admin/settings") return this.adminSettings(request);
      if (pathname === "/api/admin/logout-all" && request.method === "POST") return this.adminLogoutAll(request);
      if (pathname === "/api/admin/stats" && request.method === "GET") return this.adminStats(request);
      if (pathname === "/api/admin/users") return this.adminUsers(request);
      const userMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})\/sessions$/i.exec(pathname);
      if (userMatch && request.method === "DELETE") return this.adminRevokeUserSessions(request, userMatch[1]);
      const savedOwnerMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})\/saved\/([0-9a-f-]{36})$/i.exec(pathname);
      if (savedOwnerMatch && request.method === "DELETE") return this.adminRemoveSaved(request, savedOwnerMatch[1], savedOwnerMatch[2]);
      const userMatch2 = /^\/api\/admin\/users\/([0-9a-f-]{36})$/i.exec(pathname);
      if (userMatch2) return this.adminUser(request, userMatch2[1]);
      if (pathname === "/api/saved") {
        if (request.method === "POST") {
          const limited = await this.checkRateLimit(request, "saved", 30);
          if (limited) return limited;
        }
        return this.saved(request);
      }
      const savedMatch = /^\/api\/saved\/([0-9a-f-]{36})$/i.exec(pathname);
      if (savedMatch) return this.removeSaved(request, savedMatch[1]);
      return authJson(404, { error: "Endpoint d'authentification inconnu." });
    } catch (error) {
      return authJson(error.status || 500, { error: error.status ? error.message : "Une erreur interne est survenue." });
    }
  }

  async sessionUser(request) {
    const token = sessionFromRequest(request);
    if (!token) return null;
    const digest = await hashSession(token);
    const row = this.ctx.storage.sql.exec(
      `SELECT users.id, users.username, users.role, users.created_at, users.search_count, users.suspended
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.suspended = 0`,
      digest,
      Date.now(),
    ).toArray()[0];
    if (row) this.ctx.storage.sql.exec(
      "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
      Date.now() + SESSION_TTL_MS,
      digest,
    );
    return row ? {
      id: row.id,
      username: displayUsername(row.username),
      role: row.role,
      createdAt: row.created_at,
      searchCount: row.search_count,
    } : null;
  }

  async authorizedUser(request, admin = false) {
    const user = await this.sessionUser(request);
    if (!user) return { response: authJson(401, { error: "Authentification requise." }) };
    if (admin && user.role !== "admin") return { response: authJson(403, { error: "Réservé aux administrateurs." }) };
    return { user };
  }

  async adminStats(request) {
    const access = await this.authorizedUser(request, true);
    if (access.response) return access.response;
    const stats = this.ctx.storage.sql.exec(
      `SELECT COUNT(*) AS users,
       SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
       SUM(CASE WHEN role = 'membre' THEN 1 ELSE 0 END) AS membres,
       SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) AS suspended,
       COALESCE(SUM(search_count), 0) AS searches FROM users`,
    ).one();
    const savedSearches = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM saved_searches").one().count;
    const sessions = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?", Date.now()).one().count;
    return authJson(200, { ...stats, savedSearches, sessions });
  }

  async adminUsers(request) {
    const access = await this.authorizedUser(request, true);
    if (access.response) return access.response;
    if (request.method !== "GET") return authJson(405, { error: "Méthode non autorisée." });
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec(
      "SELECT id, username, role, created_at, search_count, suspended FROM users ORDER BY created_at DESC",
    ).toArray();
    const sessionCounts = new Map();
    for (const row of this.ctx.storage.sql.exec(
      "SELECT user_id, COUNT(*) AS count FROM sessions WHERE expires_at > ? GROUP BY user_id",
      now,
    ).toArray()) {
      sessionCounts.set(row.user_id, row.count);
    }
    const savedCounts = new Map();
    for (const row of this.ctx.storage.sql.exec(
      "SELECT user_id, COUNT(*) AS count FROM saved_searches GROUP BY user_id",
    ).toArray()) {
      savedCounts.set(row.user_id, row.count);
    }
    return authJson(200, { users: rows.map((row) => ({
      id: row.id,
      username: displayUsername(row.username),
      role: row.role,
      createdAt: row.created_at,
      searchCount: row.search_count,
      suspended: Boolean(row.suspended),
      sessions: sessionCounts.get(row.id) || 0,
      savedCount: savedCounts.get(row.id) || 0,
    })) });
  }

  adminUserView(row) {
    return {
      id: row.id,
      username: displayUsername(row.username),
      role: row.role,
      createdAt: row.created_at,
      searchCount: row.search_count,
      suspended: Boolean(row.suspended),
    };
  }

  async adminUser(request, targetId) {
    const access = await this.authorizedUser(request, true);
    if (access.response) return access.response;
    if (request.method === "GET") {
      const target = this.ctx.storage.sql.exec(
        "SELECT id, username, role, created_at, search_count, suspended FROM users WHERE id = ?",
        targetId,
      ).toArray()[0];
      if (!target) return authJson(404, { error: "Utilisateur introuvable." });
      const liveSessions = this.ctx.storage.sql.exec(
        "SELECT expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC",
        targetId,
        Date.now(),
      ).toArray();
      const saved = this.ctx.storage.sql.exec(
        "SELECT id, user_id, label, payload, created_at FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC",
        targetId,
      ).toArray().map((row) => {
        let payload = {};
        try { payload = JSON.parse(row.payload); } catch { payload = {}; }
        return { id: row.id, userId: row.user_id, label: row.label, payload, createdAt: row.created_at };
      });
      return authJson(200, {
        user: {
          ...this.adminUserView(target),
          // Cloudflare deployments do not collect profile e-mail/preferences.
          email: null,
          lang: null,
          timezone: null,
          datefmt: null,
        },
        sessions: liveSessions.map((row) => ({ expiresAt: new Date(row.expires_at).toISOString() })),
        saved,
        stats: {
          searches: target.search_count,
          savedSearches: saved.length,
          sessions: liveSessions.length,
        },
      });
    }
    if (request.method === "PATCH") {
      const body = await this.readBody(request);
      const target = this.ctx.storage.sql.exec(
        "SELECT id, username, role, created_at, search_count, suspended FROM users WHERE id = ?",
        targetId,
      ).toArray()[0];
      if (!target) return authJson(404, { error: "Utilisateur introuvable." });

      if (body.password !== undefined) {
        if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH) {
          return authJson(400, { error: `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.` });
        }
        if (body.password.length > 200) return authJson(400, { error: "Le mot de passe est trop long (200 caractères maximum)." });
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const hash = await hashPassword(body.password, salt);
        this.ctx.storage.sql.exec(
          "UPDATE users SET salt = ?, password_hash = ? WHERE id = ?",
          toHex(salt),
          toHex(hash),
          targetId,
        );
        this.ctx.storage.sql.exec("DELETE FROM sessions WHERE user_id = ?", targetId);
        return authJson(200, { user: this.adminUserView(target) });
      }

      if (body.suspended !== undefined) {
        if (typeof body.suspended !== "boolean") return authJson(400, { error: "Le champ « suspended » doit être un booléen." });
        if (targetId === access.user.id) return authJson(400, { error: "Vous ne pouvez pas suspendre votre propre compte." });
        if (body.suspended && target.role === "admin"
          && this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").one().count <= 1) {
          return authJson(400, { error: "Impossible de suspendre le dernier administrateur." });
        }
        this.ctx.storage.sql.exec("UPDATE users SET suspended = ? WHERE id = ?", body.suspended ? 1 : 0, targetId);
        if (body.suspended) this.ctx.storage.sql.exec("DELETE FROM sessions WHERE user_id = ?", targetId);
        return authJson(200, { user: this.adminUserView({ ...target, suspended: body.suspended ? 1 : 0 }) });
      }

      if (!["admin", "membre"].includes(body.role)) return authJson(400, { error: "Rôle inconnu (attendu : admin ou membre)." });
      if (target.role === "admin" && body.role !== "admin") {
        const admins = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").one().count;
        if (admins <= 1) return authJson(400, { error: "Impossible de rétrograder le dernier administrateur." });
      }
      this.ctx.storage.sql.exec("UPDATE users SET role = ? WHERE id = ?", body.role, targetId);
      return authJson(200, { user: this.adminUserView({ ...target, role: body.role }) });
    }
    if (request.method === "DELETE") {
      if (targetId === access.user.id) return authJson(400, { error: "Vous ne pouvez pas supprimer votre propre compte." });
      const target = this.ctx.storage.sql.exec("SELECT id, username, role FROM users WHERE id = ?", targetId).toArray()[0];
      if (!target) return authJson(404, { error: "Utilisateur introuvable." });
      if (target.role === "admin" && this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").one().count <= 1) {
        return authJson(400, { error: "Impossible de supprimer le dernier administrateur." });
      }
      this.ctx.storage.sql.exec("DELETE FROM saved_searches WHERE user_id = ?", targetId);
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE user_id = ?", targetId);
      this.ctx.storage.sql.exec("DELETE FROM users WHERE id = ?", targetId);
      return authJson(200, { user: { id: target.id, username: displayUsername(target.username), role: target.role } });
    }
    return authJson(405, { error: "Méthode non autorisée." });
  }

  /** GET/PATCH /api/admin/settings — platform switches. */
  async adminSettings(request) {
    const access = await this.authorizedUser(request, true);
    if (access.response) return access.response;
    if (request.method === "GET") return authJson(200, this.getSettings());
    if (request.method === "PATCH") {
      try {
        const body = await this.readBody(request);
        return authJson(200, this.updateSettings(body));
      } catch (error) {
        return authJson(error.status || 400, { error: error.message || "Réglages invalides." });
      }
    }
    return authJson(405, { error: "Méthode non autorisée." });
  }

  /** POST /api/admin/logout-all — kill every session but the acting admin's. */
  async adminLogoutAll(request) {
    const access = await this.authorizedUser(request, true);
    if (access.response) return access.response;
    if (request.method !== "POST") return authJson(405, { error: "Méthode non autorisée." });
    const keepHash = await hashSession(sessionFromRequest(request) || "");
    const before = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM sessions WHERE token_hash != ?",
      keepHash,
    ).one().count;
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash != ?", keepHash);
    return authJson(200, { revoked: before });
  }

  /** DELETE /api/admin/users/:id/sessions — force logout of one account. */
  async adminRevokeUserSessions(request, targetId) {
    const access = await this.authorizedUser(request, true);
    if (access.response) return access.response;
    if (request.method !== "DELETE") return authJson(405, { error: "Méthode non autorisée." });
    const target = this.ctx.storage.sql.exec("SELECT id FROM users WHERE id = ?", targetId).toArray()[0];
    if (!target) return authJson(404, { error: "Utilisateur introuvable." });
    const before = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?",
      targetId,
    ).one().count;
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE user_id = ?", targetId);
    return authJson(200, { revoked: before });
  }

  /** DELETE /api/admin/users/:id/saved/:savedId — drop one saved search. */
  async adminRemoveSaved(request, targetId, savedId) {
    const access = await this.authorizedUser(request, true);
    if (access.response) return access.response;
    if (request.method !== "DELETE") return authJson(405, { error: "Méthode non autorisée." });
    const existing = this.ctx.storage.sql.exec(
      "SELECT id FROM saved_searches WHERE id = ? AND user_id = ?",
      savedId,
      targetId,
    ).toArray()[0];
    if (!existing) return authJson(404, { error: "Recherche enregistrée introuvable." });
    this.ctx.storage.sql.exec("DELETE FROM saved_searches WHERE id = ?", savedId);
    return authJson(200, { ok: true });
  }

  async saved(request) {
    const access = await this.authorizedUser(request);
    if (access.response) return access.response;
    if (request.method === "GET") {
      const rows = this.ctx.storage.sql.exec("SELECT id, user_id, label, payload, created_at FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC", access.user.id).toArray();
      return authJson(200, { saved: rows.map((row) => ({ id: row.id, userId: row.user_id, label: row.label, payload: JSON.parse(row.payload), createdAt: row.created_at })) });
    }
    if (request.method !== "POST") return authJson(405, { error: "Méthode non autorisée." });
    const body = await this.readBody(request);
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
    if (!label) return authJson(400, { error: "Le nom de la recherche enregistrée est requis." });
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) return authJson(400, { error: "Les critères de la recherche sont invalides." });
    const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM saved_searches WHERE user_id = ?", access.user.id).one().count;
    if (count >= 50) return authJson(400, { error: "Limite de 50 recherches enregistrées atteinte." });
    const entry = { id: crypto.randomUUID(), userId: access.user.id, label, payload: body.payload, createdAt: new Date().toISOString() };
    this.ctx.storage.sql.exec("INSERT INTO saved_searches (id, user_id, label, payload, created_at) VALUES (?, ?, ?, ?, ?)", entry.id, entry.userId, entry.label, JSON.stringify(entry.payload), entry.createdAt);
    return authJson(201, { saved: entry });
  }

  async removeSaved(request, id) {
    const access = await this.authorizedUser(request);
    if (access.response) return access.response;
    if (request.method !== "DELETE") return authJson(405, { error: "Méthode non autorisée." });
    const existing = this.ctx.storage.sql.exec("SELECT id FROM saved_searches WHERE id = ? AND user_id = ?", id, access.user.id).toArray()[0];
    if (!existing) return authJson(404, { error: "Recherche enregistrée introuvable." });
    this.ctx.storage.sql.exec("DELETE FROM saved_searches WHERE id = ? AND user_id = ?", id, access.user.id);
    return authJson(200, { ok: true });
  }

  async incrementSearchCount(request) {
    const user = await this.sessionUser(request);
    if (!user) return authJson(401, { error: "Session inactive ou expirée." });
    this.ctx.storage.sql.exec("UPDATE users SET search_count = search_count + 1 WHERE id = ?", user.id);
    return authJson(200, { ok: true });
  }

  async checkRateLimit(request, action, limit) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const bucket = await hashSession(`${action}:${ip}`);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM auth_rate_limits WHERE window_started_at <= ? AND bucket != ?",
      now - 60_000,
      bucket,
    );
    const row = this.ctx.storage.sql.exec(
      "SELECT window_started_at, attempts FROM auth_rate_limits WHERE bucket = ?",
      bucket,
    ).toArray()[0];
    if (row && now - row.window_started_at < 60_000 && row.attempts >= limit) {
      return authJson(429, { error: `Trop de tentatives de ${action === "login" ? "connexion" : "création de compte"}. Réessayez dans une minute.` });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO auth_rate_limits (bucket, window_started_at, attempts) VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET
         window_started_at = CASE
           WHEN auth_rate_limits.window_started_at <= ? THEN excluded.window_started_at
           ELSE auth_rate_limits.window_started_at
         END,
         attempts = CASE
           WHEN auth_rate_limits.window_started_at <= ? THEN 1
           ELSE auth_rate_limits.attempts + 1
         END`,
      bucket,
      now,
      now - 60_000,
      now - 60_000,
    );
    return null;
  }

  async readBody(request) {
    try {
      const body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      return body;
    } catch {
      throw Object.assign(new Error("Le corps de la requête doit être un objet JSON valide."), { status: 400 });
    }
  }

  async register(request) {
    try {
      const body = await this.readBody(request);
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = body.password;
      if (!USERNAME_PATTERN.test(username)) {
        return authJson(400, { error: "Le nom d'utilisateur doit contenir 3 à 24 caractères (lettres, chiffres, point, tiret ou underscore)." });
      }
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        return authJson(400, { error: `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.` });
      }
      if (password.length > 200) return authJson(400, { error: "Le mot de passe est trop long (200 caractères maximum)." });

      const salt = crypto.getRandomValues(new Uint8Array(16));
      const passwordHash = await hashPassword(password, salt);
      const token = newToken();
      const tokenHash = await hashSession(token);
      const users = this.ctx.storage.sql;
      if (users.exec("SELECT id FROM users WHERE username = ? COLLATE NOCASE", username).toArray().length) {
        return authJson(409, { error: "Ce nom d'utilisateur est déjà pris." });
      }
      const isFirstUser = users.exec("SELECT COUNT(*) AS count FROM users").one().count === 0;
      if (!isFirstUser && this.readSetting("registrationOpen", true) === false) {
        return authJson(403, { error: "Les inscriptions sont actuellement fermées." });
      }
      if (isFirstUser) {
        if (!this.env.ADMIN_BOOTSTRAP_TOKEN) {
          return authJson(503, { error: "Initialisez le premier administrateur avec le secret ADMIN_BOOTSTRAP_TOKEN." });
        }
        const suppliedToken = typeof body.bootstrapToken === "string" ? encoder.encode(body.bootstrapToken) : new Uint8Array();
        if (!safeEqual(suppliedToken, encoder.encode(this.env.ADMIN_BOOTSTRAP_TOKEN))) {
          return authJson(403, { error: "Le jeton d'initialisation administrateur est invalide." });
        }
      }
      const user = {
        id: crypto.randomUUID(),
        username: displayUsername(username),
        role: isFirstUser ? "admin" : "membre",
        createdAt: new Date().toISOString(),
        searchCount: 0,
      };
      users.exec(
        "INSERT INTO users (id, username, salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        user.id,
        username,
        toHex(salt),
        toHex(passwordHash),
        user.role,
        user.createdAt,
      );
      users.exec(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        tokenHash,
        user.id,
        Date.now() + SESSION_TTL_MS,
      );
      const cookie = this.sessionCookie(token, request);
      return authJson(201, { user, firstUser: user.role === "admin" }, { "Set-Cookie": cookie });
    } catch (error) {
      console.error("Cloudflare account registration failed:", error);
      return authJson(error.status || 500, { error: error.status ? error.message : "Impossible de créer le compte." });
    }
  }

  async login(request) {
    try {
      const body = await this.readBody(request);
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = body.password;
      if (!USERNAME_PATTERN.test(username)) {
        return authJson(400, { error: "Le nom d'utilisateur doit contenir 3 à 24 caractères (lettres, chiffres, point, tiret ou underscore)." });
      }
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
        return authJson(400, { error: "Nom d'utilisateur ou mot de passe incorrect." });
      }
      if (this.getSettings().loginMode === "closed") {
        return authJson(503, { error: "Les connexions sont actuellement fermées." });
      }
      const row = this.ctx.storage.sql.exec(
        "SELECT id, username, salt, password_hash, role, created_at, search_count, suspended FROM users WHERE username = ? COLLATE NOCASE",
        username,
      ).toArray()[0];
      if (!row) return authJson(401, { error: "Nom d'utilisateur ou mot de passe incorrect." });

      const candidate = await hashPassword(password, fromHex(row.salt));
      if (!safeEqual(candidate, fromHex(row.password_hash))) {
        return authJson(401, { error: "Nom d'utilisateur ou mot de passe incorrect." });
      }
      if (row.suspended) {
        return authJson(403, { error: "Ce compte est suspendu. Contactez un administrateur." });
      }
      if (this.getSettings().loginMode === "admins" && row.role !== "admin") {
        return authJson(403, { error: "Les connexions sont actuellement réservées aux administrateurs." });
      }
      const user = {
        id: row.id,
        username: displayUsername(row.username),
        role: row.role,
        createdAt: row.created_at,
        searchCount: row.search_count,
        suspended: Boolean(row.suspended),
      };
      const token = await this.createSession(user.id);
      return authJson(200, { user }, { "Set-Cookie": this.sessionCookie(token, request) });
    } catch (error) {
      console.error("Cloudflare account login failed:", error);
      return authJson(error.status || 500, { error: error.status ? error.message : "Impossible d'ouvrir la session." });
    }
  }

  async createSession(userId) {
    const token = newToken();
    const digest = await hashSession(token);
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now());
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      digest,
      userId,
      Date.now() + SESSION_TTL_MS,
    );
    return token;
  }

  sessionCookie(token, request) {
    const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_TTL_MS / 1000}`];
    if (request.headers.get("X-Forwarded-Proto") === "https") parts.push("Secure");
    return parts.join("; ");
  }

  async currentUser(request) {
    const token = sessionFromRequest(request);
    if (!token) return authJson(401, { error: "Session inactive ou expirée." });
    const digest = await hashSession(token);
    const row = this.ctx.storage.sql.exec(
      `SELECT users.id, users.username, users.role, users.created_at, users.search_count, users.suspended
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.suspended = 0`,
      digest,
      Date.now(),
    ).toArray()[0];
    if (!row) return authJson(401, { error: "Session inactive ou expirée." });
    this.ctx.storage.sql.exec(
      "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
      Date.now() + SESSION_TTL_MS,
      digest,
    );
    return authJson(200, {
      user: {
        id: row.id,
        username: displayUsername(row.username),
        role: row.role,
        createdAt: row.created_at,
        searchCount: row.search_count,
        suspended: Boolean(row.suspended),
      },
    });
  }

  async logout(request) {
    const token = sessionFromRequest(request);
    if (token) {
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash = ?", await hashSession(token));
    }
    const expired = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (request.headers.get("X-Forwarded-Proto") === "https") expired.push("Secure");
    return authJson(200, { ok: true }, { "Set-Cookie": expired.join("; ") });
  }
}

function applyBirthDate(query) {
  const day = query.jour_naissance;
  const month = query.mois_naissance;
  const year = query.annee_naissance;
  delete query.jour_naissance;
  delete query.mois_naissance;
  delete query.annee_naissance;
  if (day === undefined && month === undefined && year === undefined) return;
  if (query.date_naissance) {
    throw Object.assign(
      new Error("Renseignez soit la date de naissance, soit le jour, le mois et l'année — pas les deux."),
      { status: 400 },
    );
  }
  if (year === undefined) {
    throw Object.assign(
      new Error("L'année de naissance est requise pour préciser le jour ou le mois de naissance."),
      { status: 400 },
    );
  }
  if (day !== undefined && month === undefined) {
    throw Object.assign(
      new Error("Le mois de naissance est requis pour préciser le jour de naissance."),
      { status: 400 },
    );
  }
  let date = String(year);
  if (month !== undefined) {
    date += `-${String(month).padStart(2, "0")}`;
    if (day !== undefined) date += `-${String(day).padStart(2, "0")}`;
  }
  query.date_naissance = date;
}

function buildQuery(body) {
  const query = {};
  for (const key of TEXT_FIELDS) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    if (value) query[key] = value.slice(0, 250);
  }

  for (const [key, [min, max]] of Object.entries(INTEGER_FIELDS)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isInteger(value) || value < min || value > max) {
      throw Object.assign(
        new Error(`Le champ « ${key} » doit être un entier compris entre ${min} et ${max}.`),
        { status: 400 },
      );
    }
    query[key] = value;
  }

  applyBirthDate(query);
  if (body.flexible === true || body.flexible === "true") query.flexible = true;
  if (!Object.keys(query).some((key) => !["page", "per_page", "flexible"].includes(key))) {
    throw Object.assign(new Error("Renseignez au moins un critère de recherche."), { status: 400 });
  }
  return query;
}

async function handleSearch(request, env) {
  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SEARCH_SIZE) {
      return jsonResponse(413, { error: "La requête est trop volumineuse." });
    }
    body = JSON.parse(text);
  } catch {
    return jsonResponse(400, { error: "Le corps de la requête doit être un objet JSON valide." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Le corps de la requête doit être un objet JSON valide." });
  }

  let query;
  try {
    query = buildQuery(body);
  } catch (error) {
    return jsonResponse(error.status || 400, { error: error.message });
  }

  try {
    const upstream = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    const payload = await parseSearchResponse(upstream);
    if (upstream.status >= 200 && upstream.status < 300) {
      const cookie = request.headers.get("Cookie");
      await handleAuth(new Request(new URL("/api/auth/search-count", request.url), {
        method: "POST",
        headers: cookie ? { Cookie: cookie } : undefined,
      }), env);
    }
    return jsonResponse(upstream.status, payload);
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return jsonResponse(504, { error: "Le service de recherche n'a pas répondu à temps." });
    }
    if (error instanceof SearchResponseError) {
      return jsonResponse(502, { error: error.message });
    }
    return jsonResponse(502, { error: "Impossible de joindre le service de recherche." });
  }
}

async function requireSession(request, env) {
  const headers = new Headers();
  const cookie = request.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);
  const sessionRequest = new Request(new URL("/api/auth/me", request.url), { headers });
  const response = await handleAuth(sessionRequest, env);
  return response.status === 200 ? null : response;
}

/**
 * Read the platform switches through the auth store. Returns null when the
 * store is unavailable or answers something unexpected (fail open: the
 * session check already happened).
 */
async function fetchSettings(request, env) {
  try {
    const response = await handleAuth(new Request(new URL("/api/settings", request.url), { method: "GET" }), env);
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function applySearchLimit(request, env) {
  if (!env.SEARCH_RATE_LIMITER) {
    return jsonResponse(503, { error: "La limitation de débit des recherches n'est pas configurée." });
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  try {
    const { success } = await env.SEARCH_RATE_LIMITER.limit({ key: `search:${ip}` });
    if (!success) {
      return Response.json(
        { error: "Limite de recherches atteinte. Réessayez dans une minute." },
        { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60", ...SECURITY_HEADERS } },
      );
    }
  } catch (error) {
    console.error("Cloudflare search rate limiter failed:", error);
    return jsonResponse(503, { error: "Le service de limitation des recherches est indisponible." });
  }
  return null;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/auth/search-count") return jsonResponse(404, { error: "Endpoint inconnu." });
    if (pathname === "/api/settings"
      || pathname.startsWith("/api/auth/")
      || pathname.startsWith("/api/admin/")
      || pathname === "/api/saved"
      || pathname.startsWith("/api/saved/")) {
      if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method)) {
        return jsonResponse(405, { error: "Méthode non autorisée." });
      }
      return secureResponse(await handleAuth(request, env), "no-store");
    }
    if (pathname === "/api/search") {
      if (request.method !== "POST") {
        return jsonResponse(405, { error: "Méthode non autorisée." });
      }
      const sessionError = await requireSession(request, env);
      if (sessionError) return secureResponse(sessionError, "no-store");
      const settings = await fetchSettings(request, env);
      if (settings && settings.searchEnabled === false) {
        return jsonResponse(503, { error: "Les recherches sont actuellement suspendues par un administrateur." });
      }
      const rateLimitError = await applySearchLimit(request, env);
      if (rateLimitError) return rateLimitError;
      return handleSearch(request, env);
    }
    if (pathname.startsWith("/api/")) return jsonResponse(404, { error: "Endpoint inconnu." });
    const response = await env.ASSETS.fetch(request);
    const cacheControl = ["/", "/index.html"].includes(pathname)
      ? "no-cache"
      : ["/styles.css", "/app.js"].includes(pathname)
        ? "public, max-age=300"
        : "no-store";
    return secureResponse(response, cacheControl);
  },
};
