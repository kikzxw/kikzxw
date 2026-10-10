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

function jsonResponse(status, payload) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
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
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
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
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

export class AuthStore {
  constructor(ctx) {
    this.ctx = ctx;
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
          search_count INTEGER NOT NULL DEFAULT 0
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
    });
  }

  async fetch(request) {
    await this.ready;
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
    return authJson(404, { error: "Endpoint d'authentification inconnu." });
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
      const user = {
        id: crypto.randomUUID(),
        username: displayUsername(username),
        role: users.exec("SELECT COUNT(*) AS count FROM users").one().count === 0 ? "admin" : "membre",
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
      const row = this.ctx.storage.sql.exec(
        "SELECT id, username, salt, password_hash, role, created_at, search_count FROM users WHERE username = ? COLLATE NOCASE",
        username,
      ).toArray()[0];
      if (!row) return authJson(401, { error: "Nom d'utilisateur ou mot de passe incorrect." });

      const candidate = await hashPassword(password, fromHex(row.salt));
      if (!safeEqual(candidate, fromHex(row.password_hash))) {
        return authJson(401, { error: "Nom d'utilisateur ou mot de passe incorrect." });
      }
      const user = {
        id: row.id,
        username: displayUsername(row.username),
        role: row.role,
        createdAt: row.created_at,
        searchCount: row.search_count,
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
      `SELECT users.id, users.username, users.role, users.created_at, users.search_count
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
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

async function handleSearch(request) {
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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/auth/")) {
      if (!["GET", "POST"].includes(request.method)) {
        return jsonResponse(405, { error: "Méthode non autorisée." });
      }
      return handleAuth(request, env);
    }
    if (pathname === "/api/search") {
      if (request.method !== "POST") {
        return jsonResponse(405, { error: "Méthode non autorisée." });
      }
      return handleSearch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
