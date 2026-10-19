"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const searchResponseModule = import("./search-response.mjs");
const store = require("./store");

const SESSION_COOKIE = "rt_session";

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.resolve(__dirname, "..");
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
const ADMIN_BOOTSTRAP_TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const TLS_CERT_PATH = process.env.TLS_CERT || "";
const TLS_KEY_PATH = process.env.TLS_KEY || "";
const RATE_LIMIT_SEARCH = Math.max(1, Number(process.env.RATE_LIMIT_SEARCH || 20));
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const MAX_REQUEST_SIZE = 2 * 1024;
const MAX_SEARCH_SIZE = 16 * 1024;
const SEARCH_ENDPOINT = process.env.SEARCH_ENDPOINT || atob("aHR0cHM6Ly9hcGkuYnJpeGh1Yi5ydS9hcGkvdjEvc2VhcmNo");
const SEARCH_TIMEOUT_MS = 20_000;
const APP_VERSION = "1.0.0";

const SEARCH_TEXT_FIELDS = [
  "nom_famille", "prenom",
  "date_naissance", "ville_naissance", "genre",
  "email", "telephone", "nom_utilisateur", "adresse_ip",
  "adresse", "code_postal", "ville",
  "steam_id", "fivem_license", "fivem_license2", "discord_id",
  "xbox_live_id", "live_id",
  "nir", "iban", "bic", "vin_plaque",
];
const SEARCH_INT_FIELDS = {
  annee_naissance: [1800, 2100],
  jour_naissance: [1, 31],
  mois_naissance: [1, 12],
  page: [1, 100000],
  per_page: [1, 100],
};
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const useTls = Boolean(TLS_CERT_PATH && TLS_KEY_PATH);

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self' https://cdn.jsdelivr.net; style-src 'self'; font-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // Improvement #11 — enhanced security headers
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  // HSTS is only safe over HTTPS; added dynamically per-request when useTls
};

// ─── Global error handlers (improvement #2) ───────────────────────────────────

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
  // Do NOT exit — let the server keep running unless absolutely critical.
});

process.on("unhandledRejection", (reason) => {
  console.warn("[unhandledRejection]", reason);
});

// ─── Rate-limit buckets (improvement #5: cleanup interval) ────────────────────

const rateBuckets = new Map();

function cleanupRateBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

// Run every 2 minutes; .unref() lets the process exit naturally even if the
// timer is still pending.
setInterval(cleanupRateBuckets, 2 * 60 * 1000).unref();

// ─── Static file cache (improvement #12) ─────────────────────────────────────

const staticCache = new Map(); // pathname → { content, etag, mtime, type }

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a short request ID (improvement #9).
 */
function generateRequestId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Anonymise the last octet of an IPv4 address, or the last group of IPv6.
 */
function anonymiseIp(ip) {
  if (!ip || ip === "inconnu") return "0.0.0.0";
  // IPv4
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.0`;
  // IPv4-mapped IPv6 ::ffff:a.b.c.d
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i);
  if (mapped) return `${mapped[1]}.0`;
  // IPv6 — zero out last group
  const parts = ip.split(":");
  if (parts.length > 1) {
    parts[parts.length - 1] = "0";
    return parts.join(":");
  }
  return ip;
}

/**
 * Static paths that should not be logged (improvement #3 — noise reduction).
 */
function isStaticPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".js")
  );
}

function clientIp(request) {
  if (TRUST_PROXY) {
    const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (net.isIP(forwarded)) return forwarded;
  }
  return request.socket.remoteAddress || "inconnu";
}

function isAuthorized(request) {
  if (!AUTH_USER && !AUTH_PASS) return true;
  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const expected = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`);
  const received = Buffer.from(header.slice(6), "base64");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function matchesBootstrapToken(supplied) {
  const candidate = Buffer.from(typeof supplied === "string" ? supplied : "");
  const expected = Buffer.from(ADMIN_BOOTSTRAP_TOKEN);
  return Boolean(expected.length) && candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function challengeUnauthorized(response) {
  sendJson(response, 401, { error: "Authentification requise." }, { "WWW-Authenticate": 'Basic realm="KIKZXW", charset="UTF-8"' });
}

/**
 * Build CORS headers if CORS_ORIGIN env var is set (improvement #7).
 * Never added by default in production for security.
 */
function corsHeaders(request) {
  if (!CORS_ORIGIN) return {};
  const origin = request.headers.origin || "";
  if (!origin) return {};
  // Only allow the explicitly configured origin
  if (CORS_ORIGIN === "*" || origin === CORS_ORIGIN) {
    return {
      "Access-Control-Allow-Origin": CORS_ORIGIN === "*" ? "*" : origin,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    };
  }
  return {};
}

/**
 * HSTS header — only sent over HTTPS (improvement #11).
 */
function hstsHeader() {
  if (!useTls) return {};
  return { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" };
}

// ─── Compression (improvement #6) ─────────────────────────────────────────────

const COMPRESS_MIN_BYTES = 1024;
const COMPRESSIBLE_TYPES = ["application/json", "text/html", "text/plain", "text/css", "text/javascript"];

function acceptsGzip(request) {
  const ae = request.headers["accept-encoding"] || "";
  return ae.includes("gzip");
}

function isCompressible(contentType) {
  return COMPRESSIBLE_TYPES.some((t) => contentType && contentType.startsWith(t));
}

/**
 * Send a response, compressing with gzip when appropriate.
 * Sets Content-Length so HTTP keep-alive works properly (improvement #10).
 */
function sendCompressed(request, response, statusCode, body, headers) {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const contentType = headers["Content-Type"] || "";

  const shouldCompress =
    acceptsGzip(request) &&
    bodyBuf.length > COMPRESS_MIN_BYTES &&
    isCompressible(contentType);

  if (shouldCompress) {
    zlib.gzip(bodyBuf, (err, compressed) => {
      if (err) {
        // Fall back to uncompressed on zlib error
        response.writeHead(statusCode, {
          ...headers,
          "Content-Length": String(bodyBuf.length),
        });
        response.end(bodyBuf);
        return;
      }
      response.writeHead(statusCode, {
        ...headers,
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.length),
        "Vary": "Accept-Encoding",
      });
      response.end(compressed);
    });
  } else {
    response.writeHead(statusCode, {
      ...headers,
      "Content-Length": String(bodyBuf.length),
    });
    response.end(bodyBuf);
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function buildBaseHeaders(request) {
  return {
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...hstsHeader(),
    ...corsHeaders(request),
  };
}

function sendJson(response, statusCode, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  // Retrieve the request attached to the response for compression/CORS checks.
  // It is stored in handleRequest as response._req.
  const request = response._req;
  const headers = {
    "Content-Type": MIME_TYPES[".json"],
    ...(request ? buildBaseHeaders(request) : { "Cache-Control": "no-store", ...SECURITY_HEADERS }),
    ...(extraHeaders || {}),
  };

  if (request) {
    sendCompressed(request, response, statusCode, body, headers);
  } else {
    const bodyBuf = Buffer.from(body, "utf8");
    response.writeHead(statusCode, { ...headers, "Content-Length": String(bodyBuf.length) });
    response.end(bodyBuf, (error) => {
      if (error && error.code !== "ERR_HTTP_HEADERS_SENT") {
        console.error(`sendJson write error (${statusCode}):`, error.code || error.message);
      }
    });
  }
}

function sendText(response, statusCode, text) {
  const bodyBuf = Buffer.from(text, "utf8");
  const request = response._req;
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    ...(request ? buildBaseHeaders(request) : { "Cache-Control": "no-store", ...SECURITY_HEADERS }),
    "Content-Length": String(bodyBuf.length),
  };
  response.writeHead(statusCode, headers);
  response.end(bodyBuf);
}

// ─── Rate limiting ─────────────────────────────────────────────────────────────

function isRateLimited(key, limitPerWindow, windowMs = 60_000) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (rateBuckets.size >= 10_000) cleanupRateBuckets();
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count > limitPerWindow;
}

function isRateLimitedByIp(request, limitPerMinute, scope = "default") {
  const ip = clientIp(request);
  return isRateLimited(`${scope}:ip:${ip}`, limitPerMinute, 60_000);
}

/**
 * Rate limit by username — 5 attempts per 15 minutes (improvement #8).
 */
function isRateLimitedByUsername(username, scope = "default") {
  if (!username || typeof username !== "string") return false;
  const normalised = username.toLowerCase().trim().slice(0, 128);
  return isRateLimited(`${scope}:user:${normalised}`, 5, 15 * 60_000);
}

// ─── Body reading ──────────────────────────────────────────────────────────────

function readJsonBody(request, maxBytes = MAX_REQUEST_SIZE) {
  return new Promise((resolve, reject) => {
    let body = "";
    let oversized = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (oversized) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        oversized = true;
        reject(Object.assign(new Error("La requête dépasse la taille autorisée."), { statusCode: 413 }));
      }
    });
    request.on("end", () => {
      if (oversized) return;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Le corps de la requête doit être un JSON valide."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

// ─── Search helpers ────────────────────────────────────────────────────────────

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
      { statusCode: 400 },
    );
  }
  if (year === undefined) {
    throw Object.assign(
      new Error("L'année de naissance est requise pour préciser le jour ou le mois de naissance."),
      { statusCode: 400 },
    );
  }
  if (day !== undefined && month === undefined) {
    throw Object.assign(
      new Error("Le mois de naissance est requis pour préciser le jour de naissance."),
      { statusCode: 400 },
    );
  }
  let date = String(year);
  if (month !== undefined) {
    date += `-${String(month).padStart(2, "0")}`;
    if (day !== undefined) date += `-${String(day).padStart(2, "0")}`;
  }
  query.date_naissance = date;
}

function buildSearchQuery(body) {
  const query = {};
  for (const key of SEARCH_TEXT_FIELDS) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    if (value) query[key] = value.slice(0, 250);
  }
  for (const [key, bounds] of Object.entries(SEARCH_INT_FIELDS)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const [min, max] = bounds;
    const value = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isInteger(value) || value < min || value > max) {
      throw Object.assign(new Error(`Le champ « ${key} » doit être un entier compris entre ${min} et ${max}.`), { statusCode: 400 });
    }
    query[key] = value;
  }
  applyBirthDate(query);
  if (body.flexible === true || body.flexible === "true") query.flexible = true;
  const hasCriteria = Object.keys(query).some((key) => !["page", "per_page", "flexible"].includes(key));
  if (!hasCriteria) {
    throw Object.assign(new Error("Renseignez au moins un critère de recherche."), { statusCode: 400 });
  }
  return query;
}

// ─── Route handlers ────────────────────────────────────────────────────────────

async function handleSearch(request, response, userId) {
  try {
    const body = await readJsonBody(request, MAX_SEARCH_SIZE);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(response, 400, { error: "Le corps de la requête doit être un objet JSON valide." });
      return;
    }
    const query = buildSearchQuery(body);
    const upstream = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    const { parseSearchResponse } = await searchResponseModule;
    const payload = await parseSearchResponse(upstream);
    if (upstream.status >= 200 && upstream.status < 300) {
      store.incrementSearchCount(userId);
    }
    sendJson(response, upstream.status, payload);
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError" || error.code === "UND_ERR_CONNECT_TIMEOUT") {
      sendJson(response, 504, { error: "Le service de recherche n'a pas répondu à temps." });
      return;
    }
    if (error.name === "SearchResponseError") {
      sendJson(response, 502, { error: error.message });
      return;
    }
    sendJson(response, error.statusCode || 502, {
      error: error.message || "Impossible de joindre le service de recherche.",
    });
  }
}

function readSession(request) {
  const cookieHeader = request.headers.cookie || "";
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})(?:;|$)`).exec(cookieHeader);
  if (!match) return null;
  return store.getSession(match[1]);
}

function secureRequest(request) {
  if (useTls) return true;
  if (!TRUST_PROXY) return false;
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https";
}

function sessionCookie(token, request) {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=604800"];
  if (secureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

function clearedSessionCookie(request) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

function sendAuthError(response, error) {
  sendJson(response, error.status || 400, { error: error.message || "Requête invalide." });
}

async function readAuthBody(request) {
  const body = await readJsonBody(request, 4 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("Le corps de la requête doit être un objet JSON valide."), { status: 400 });
  }
  return body;
}

async function handleRegister(request, response) {
  if (isRateLimitedByIp(request, 10, "register")) {
    sendJson(response, 429, { error: "Trop de tentatives de création de compte. Réessayez dans une minute." }, { "Retry-After": "60" });
    return;
  }
  let body;
  try {
    body = await readAuthBody(request);

    // Improvement #8: per-username rate limit for register
    if (body.username && isRateLimitedByUsername(body.username, "register")) {
      sendJson(response, 429, { error: "Trop de tentatives pour ce nom d'utilisateur. Réessayez dans 15 minutes." }, { "Retry-After": "900" });
      return;
    }

    const firstUser = store.userCount() === 0;
    // Admin can close sign-ups; the bootstrap (very first account) stays possible.
    if (!firstUser && !store.getSettings().registrationOpen) {
      sendJson(response, 403, { error: "Les inscriptions sont actuellement fermées." });
      return;
    }
    if (firstUser && !ADMIN_BOOTSTRAP_TOKEN) {
      sendJson(response, 503, { error: "Initialisez le premier administrateur avec le secret ADMIN_BOOTSTRAP_TOKEN." });
      return;
    }
    if (firstUser && !matchesBootstrapToken(body.bootstrapToken)) {
      sendJson(response, 403, { error: "Le jeton d'initialisation administrateur est invalide." });
      return;
    }
    const user = store.createUser(body.username, body.password, firstUser ? "admin" : "membre");
    const token = store.createSession(user.id);
    response.setHeader("Set-Cookie", sessionCookie(token, request));
    sendJson(response, 201, { user: store.accountUser(user), firstUser: user.role === "admin" });
  } catch (error) {
    sendAuthError(response, error);
  }
}

async function handleLogin(request, response) {
  if (isRateLimitedByIp(request, 15, "login")) {
    sendJson(response, 429, { error: "Trop de tentatives de connexion. Réessayez dans une minute." }, { "Retry-After": "60" });
    return;
  }
  let body;
  try {
    body = await readAuthBody(request);

    // Improvement #8: per-username rate limit for login
    if (body.username && isRateLimitedByUsername(body.username, "login")) {
      sendJson(response, 429, { error: "Trop de tentatives pour ce nom d'utilisateur. Réessayez dans 15 minutes." }, { "Retry-After": "900" });
      return;
    }

    // Platform-wide login switch (closed = nobody, admins = admins only).
    if (store.getSettings().loginMode === "closed") {
      sendJson(response, 503, { error: "Les connexions sont actuellement fermées." });
      return;
    }

    const user = store.authenticate(body.username, body.password);
    if (store.getSettings().loginMode === "admins" && user.role !== "admin") {
      sendJson(response, 403, { error: "Les connexions sont actuellement réservées aux administrateurs." });
      return;
    }
    const token = store.createSession(user.id);
    response.setHeader("Set-Cookie", sessionCookie(token, request));
    sendJson(response, 200, { user: store.accountUser(user) });
  } catch (error) {
    sendAuthError(response, error);
  }
}

function handleLogout(request, response) {
  const session = readSession(request);
  if (session) store.revokeSession(session.token);
  response.setHeader("Set-Cookie", clearedSessionCookie(request));
  sendJson(response, 200, { ok: true });
}

function handleMe(request, response) {
  const session = readSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Session inactive ou expirée." });
    return;
  }
  sendJson(response, 200, { user: store.accountUser(session.user) });
}

async function handleAdminUsers(request, response, pathname) {
  const session = readSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Authentification requise." });
    return;
  }
  if (session.user.role !== "admin") {
    sendJson(response, 403, { error: "Réservé aux administrateurs." });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/users") {
    sendJson(response, 200, { users: store.listUsersForAdmin() });
    return;
  }

  const targetId = /^\/api\/admin\/users\/([0-9a-f-]{36})/.exec(pathname)?.[1];
  if (!targetId) {
    sendJson(response, 404, { error: "Endpoint inconnu." });
    return;
  }

  // Sub-resources: /api/admin/users/:id/sessions and /api/admin/users/:id/saved/:savedId
  const sessionsMatch = /^\/api\/admin\/users\/[0-9a-f-]{36}\/sessions$/.exec(pathname);
  if (sessionsMatch) {
    if (request.method !== "DELETE") {
      sendJson(response, 405, { error: "Méthode non autorisée." });
      return;
    }
    try {
      const revoked = store.revokeUserSessions(targetId);
      sendJson(response, 200, { revoked });
    } catch (error) {
      sendAuthError(response, error);
    }
    return;
  }

  const savedMatch = /^\/api\/admin\/users\/[0-9a-f-]{36}\/saved\/([0-9a-f-]{36})$/.exec(pathname);
  if (savedMatch) {
    if (request.method !== "DELETE") {
      sendJson(response, 405, { error: "Méthode non autorisée." });
      return;
    }
    try {
      store.removeSaved(targetId, savedMatch[1]);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendAuthError(response, error);
    }
    return;
  }

  // Reject unknown sub-paths instead of falling through to the base resource.
  if (pathname !== `/api/admin/users/${targetId}`) {
    sendJson(response, 404, { error: "Endpoint inconnu." });
    return;
  }

  try {
    if (request.method === "GET") {
      sendJson(response, 200, store.adminUserDetail(targetId));
      return;
    }
    if (request.method === "PATCH") {
      const body = await readAuthBody(request);
      if (body.password !== undefined) {
        const user = store.resetPassword(targetId, body.password);
        sendJson(response, 200, { user });
      } else if (body.suspended !== undefined) {
        const user = store.setSuspended(session.user, targetId, body.suspended);
        sendJson(response, 200, { user });
      } else {
        const user = store.setRole(session.user, targetId, body.role);
        sendJson(response, 200, { user });
      }
      return;
    }
    if (request.method === "DELETE") {
      const user = store.deleteUser(session.user, targetId);
      sendJson(response, 200, { user });
      return;
    }
    sendJson(response, 405, { error: "Méthode non autorisée." });
  } catch (error) {
    sendAuthError(response, error);
  }
}

/** GET /api/admin/settings · PATCH /api/admin/settings — platform switches. */
async function handleAdminSettings(request, response) {
  const session = readSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Authentification requise." });
    return;
  }
  if (session.user.role !== "admin") {
    sendJson(response, 403, { error: "Réservé aux administrateurs." });
    return;
  }
  if (request.method === "GET") {
    sendJson(response, 200, store.getSettings());
    return;
  }
  if (request.method === "PATCH") {
    try {
      const body = await readAuthBody(request);
      sendJson(response, 200, store.updateSettings(body));
    } catch (error) {
      sendAuthError(response, error);
    }
    return;
  }
  sendJson(response, 405, { error: "Méthode non autorisée." });
}

/**
 * POST /api/admin/logout-all — force-logout of every account except the
 * acting admin's own session.
 */
function handleLogoutAll(request, response) {
  const session = readSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Authentification requise." });
    return;
  }
  if (session.user.role !== "admin") {
    sendJson(response, 403, { error: "Réservé aux administrateurs." });
    return;
  }
  const revoked = store.revokeAllSessions(session.token);
  sendJson(response, 200, { revoked });
}

function handleAdminStats(request, response) {
  const session = readSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Authentification requise." });
    return;
  }
  if (session.user.role !== "admin") {
    sendJson(response, 403, { error: "Réservé aux administrateurs." });
    return;
  }
  sendJson(response, 200, store.stats());
}

async function handleUserProfile(request, response, pathname) {
  const session = readSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Authentification requise." });
    return;
  }
  if (request.method === "PATCH" && pathname === "/api/user/profile") {
    try {
      const body = await readAuthBody(request);
      const { email, lang, timezone, datefmt } = body;
      const user = store.updateUserProfile(session.user.id, { email, lang, timezone, datefmt });
      sendJson(response, 200, { user });
    } catch (error) {
      sendAuthError(response, error);
    }
    return;
  }
  if (request.method === "PATCH" && pathname === "/api/user/password") {
    try {
      const body = await readAuthBody(request);
      const { currentPassword, newPassword } = body;
      if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
        throw Object.assign(new Error("Champs requis manquants."), { status: 400 });
      }
      if (newPassword.length < 8) {
        throw Object.assign(new Error("Le nouveau mot de passe doit contenir au moins 8 caractères."), { status: 400 });
      }
      const user = store.changePassword(session.user.id, currentPassword, newPassword);
      sendJson(response, 200, { user });
    } catch (error) {
      sendAuthError(response, error);
    }
    return;
  }
  if (request.method === "DELETE" && pathname === "/api/user/account") {
    try {
      store.deleteOwnAccount(session.user.id);
      const clearedCookie = clearedSessionCookie(request);
      response.setHeader("Set-Cookie", clearedCookie);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendAuthError(response, error);
    }
    return;
  }
  sendJson(response, 405, { error: "Méthode non autorisée." });
}

async function handleSaved(request, response, pathname) {
  const session = readSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Authentification requise." });
    return;
  }

  if (request.method === "GET") {
    sendJson(response, 200, { saved: store.listSaved(session.user.id) });
    return;
  }
  if (request.method === "POST") {
    if (isRateLimitedByIp(request, 30, "saved")) {
      sendJson(response, 429, { error: "Trop de requêtes. Réessayez dans une minute." });
      return;
    }
    try {
      const body = await readAuthBody(request);
      const entry = store.addSaved(session.user.id, body.label, body.payload);
      sendJson(response, 201, { saved: entry });
    } catch (error) {
      sendAuthError(response, error);
    }
    return;
  }
  const deleteMatch = /^\/api\/saved\/([0-9a-f-]{36})$/.exec(pathname);
  if (request.method === "DELETE" && deleteMatch) {
    try {
      store.removeSaved(session.user.id, deleteMatch[1]);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendAuthError(response, error);
    }
    return;
  }
  sendJson(response, 405, { error: "Méthode non autorisée." });
}

// ─── Health check (improvement #4) ────────────────────────────────────────────

function handleHealth(response) {
  const payload = {
    status: "ok",
    uptime: Math.floor(process.uptime()),
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  };
  sendJson(response, 200, payload);
}

// ─── Static file serving (improvement #12: ETag + 304 + memory cache) ─────────

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: MIME_TYPES[".html"] }],
  ["/index.html", { file: "index.html", type: MIME_TYPES[".html"] }],
  ["/styles.css", { file: "styles.css", type: MIME_TYPES[".css"] }],
  ["/app.js", { file: "app.js", type: MIME_TYPES[".js"] }],
  ["/manifest.json", { file: "manifest.json", type: "application/manifest+json" }],
]);

const STATIC_CACHE_MAX_BYTES = 500 * 1024; // 500 KB per file

/**
 * Compute ETag from file mtime (fast, no content hashing needed for small files).
 */
function computeEtag(mtime) {
  return `"${mtime.getTime().toString(16)}"`;
}

function serveStatic(request, response) {
  let pathname;
  try {
    pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  const asset = STATIC_FILES.get(pathname);
  if (!asset) {
    sendText(response, 404, "Not found");
    return;
  }

  const filePath = path.join(ROOT, asset.file);
  const cached = staticCache.get(pathname);

  // Try serving from memory cache first (improvement #12)
  if (cached) {
    const clientEtag = request.headers["if-none-match"];
    if (clientEtag && clientEtag === cached.etag) {
      response.writeHead(304, {
        ETag: cached.etag,
        "Cache-Control": pathname === "/" || pathname === "/index.html" ? "no-cache" : "public, max-age=300",
        ...SECURITY_HEADERS,
        ...hstsHeader(),
        ...corsHeaders(request),
      });
      response.end();
      return;
    }
    const headers = {
      "Content-Type": asset.type,
      "Cache-Control": pathname === "/" || pathname === "/index.html" ? "no-cache" : "public, max-age=300",
      ETag: cached.etag,
      ...SECURITY_HEADERS,
      ...hstsHeader(),
      ...corsHeaders(request),
      "Content-Length": String(cached.content.length),
    };
    response.writeHead(200, headers);
    response.end(cached.content);
    return;
  }

  // Read from disk, populate cache if small enough
  fs.stat(filePath, (statErr, stats) => {
    if (statErr) {
      sendText(response, statErr.code === "ENOENT" ? 404 : 500, statErr.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    const etag = computeEtag(stats.mtime);

    // ETag match → 304
    const clientEtag = request.headers["if-none-match"];
    if (clientEtag && clientEtag === etag) {
      response.writeHead(304, {
        ETag: etag,
        "Cache-Control": pathname === "/" || pathname === "/index.html" ? "no-cache" : "public, max-age=300",
        ...SECURITY_HEADERS,
        ...hstsHeader(),
        ...corsHeaders(request),
      });
      response.end();
      return;
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        sendText(response, readErr.code === "ENOENT" ? 404 : 500, readErr.code === "ENOENT" ? "Not found" : "Server error");
        return;
      }

      // Cache small files in memory
      if (content.length <= STATIC_CACHE_MAX_BYTES) {
        staticCache.set(pathname, { content, etag, mtime: stats.mtime, type: asset.type });
      }

      const headers = {
        "Content-Type": asset.type,
        "Cache-Control": pathname === "/" || pathname === "/index.html" ? "no-cache" : "public, max-age=300",
        ETag: etag,
        ...SECURITY_HEADERS,
        ...hstsHeader(),
        ...corsHeaders(request),
        "Content-Length": String(content.length),
      };
      response.writeHead(200, headers);
      response.end(content);
    });
  });
}

// ─── CORS preflight ────────────────────────────────────────────────────────────

function handleOptions(request, response) {
  if (!CORS_ORIGIN) {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(204, {
    ...corsHeaders(request),
    ...SECURITY_HEADERS,
    ...hstsHeader(),
  });
  response.end();
}

// ─── Main request dispatcher (improvement #3: structured logging + #9: request ID) ──

function handleRequest(request, response) {
  const requestId = generateRequestId();
  const startTime = Date.now();

  // Attach request to response so helpers (sendJson etc.) can access it
  response._req = request;

  // Inject X-Request-Id in every response (improvement #9)
  response.setHeader("X-Request-Id", requestId);

  // Intercept writeHead to capture status for logging (improvement #3)
  const originalWriteHead = response.writeHead.bind(response);
  let loggedStatus = 0;
  response.writeHead = function patchedWriteHead(statusCode, ...args) {
    loggedStatus = statusCode;
    return originalWriteHead(statusCode, ...args);
  };

  // Log on finish (improvement #3)
  let pathname = "";
  try {
    pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  } catch {
    // Will be handled below
  }

  response.on("finish", () => {
    if (!isStaticPath(pathname)) {
      const durationMs = Date.now() - startTime;
      const anonIp = anonymiseIp(clientIp(request));
      console.log(
        `[${new Date().toISOString()}] ${request.method} ${pathname} ${loggedStatus} ${durationMs}ms ip=${anonIp} reqId=${requestId}`,
      );
    }
  });

  // Handle CORS preflight before auth check
  if (request.method === "OPTIONS") {
    handleOptions(request, response);
    return;
  }

  if (!isAuthorized(request)) {
    challengeUnauthorized(response);
    return;
  }

  // Re-use already-parsed pathname (re-parse only if it failed above)
  if (!pathname) {
    try {
      pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
    } catch {
      sendJson(response, 400, { error: "Requête invalide." });
      return;
    }
  }

  // Improvement #4: health check (no auth required — moved inside auth block
  // intentionally so the Basic-auth wrapper still protects it when configured;
  // if you want it truly unauthenticated, move this block above isAuthorized).
  if (request.method === "GET" && pathname === "/health") {
    handleHealth(response);
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/register") {
    handleRegister(request, response);
  } else if (request.method === "POST" && pathname === "/api/auth/login") {
    handleLogin(request, response);
  } else if (request.method === "POST" && pathname === "/api/auth/logout") {
    handleLogout(request, response);
  } else if (request.method === "GET" && pathname === "/api/auth/me") {
    handleMe(request, response);
  } else if (request.method === "GET" && pathname === "/api/settings") {
    // Public subset of the platform switches (auth screen needs it).
    sendJson(response, 200, store.getSettings());
  } else if (pathname.startsWith("/api/user/")) {
    handleUserProfile(request, response, pathname);
  } else if (pathname === "/api/admin/settings") {
    handleAdminSettings(request, response);
  } else if (pathname === "/api/admin/logout-all") {
    if (request.method !== "POST") sendJson(response, 405, { error: "Méthode non autorisée." });
    else handleLogoutAll(request, response);
  } else if (pathname === "/api/admin/stats") {
    if (request.method !== "GET") sendJson(response, 405, { error: "Méthode non autorisée." });
    else handleAdminStats(request, response);
  } else if (pathname === "/api/admin/users" || pathname.startsWith("/api/admin/users/")) {
    handleAdminUsers(request, response, pathname);
  } else if (pathname === "/api/saved" || pathname.startsWith("/api/saved/")) {
    handleSaved(request, response, pathname);
  } else if (request.method === "POST" && pathname === "/api/search") {
    const session = readSession(request);
    if (!session) {
      sendJson(response, 401, { error: "Connexion requise pour effectuer une recherche." });
    } else if (!store.getSettings().searchEnabled) {
      sendJson(response, 503, { error: "Les recherches sont actuellement suspendues par un administrateur." });
    } else if (isRateLimitedByIp(request, RATE_LIMIT_SEARCH, "search")) {
      sendJson(response, 429, { error: "Trop de requêtes. Réessayez dans une minute." }, { "Retry-After": "60" });
    } else {
      handleSearch(request, response, session.user.id);
    }
  } else if (request.method === "GET") {
    serveStatic(request, response);
  } else if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "Endpoint inconnu." });
  } else {
    sendJson(response, 405, { error: "Méthode non autorisée." });
  }
}

// ─── Server creation ───────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

let publicServer = server;
if (useTls) {
  try {
    publicServer = https.createServer(
      { cert: fs.readFileSync(TLS_CERT_PATH), key: fs.readFileSync(TLS_KEY_PATH) },
      handleRequest,
    );
    publicServer.requestTimeout = 30_000;
    publicServer.headersTimeout = 10_000;
  } catch (error) {
    console.error(`Impossible de charger le certificat TLS : ${error.message}`);
    process.exit(1);
  }
}

// ─── Graceful shutdown (improvement #1) ───────────────────────────────────────

function gracefulShutdown(signal) {
  console.log(`Arrêt en cours (${signal})...`);
  publicServer.close(() => {
    console.log("Serveur arrêté proprement.");
    process.exit(0);
  });
  // Force exit after 10 seconds if connections are still open
  setTimeout(() => {
    console.error("Délai de fermeture dépassé, arrêt forcé.");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ─── Start ─────────────────────────────────────────────────────────────────────

publicServer.listen(PORT, HOST, () => {
  const scheme = useTls ? "https" : "http";
  console.log(`KIKZXW est disponible sur ${scheme}://${HOST}:${PORT} (version ${APP_VERSION})`);
  if (!AUTH_USER && !AUTH_PASS) {
    console.log("Attention : aucune authentification n'est configurée (variables AUTH_USER / AUTH_PASS).");
  }
  if (CORS_ORIGIN) {
    console.log(`CORS activé pour : ${CORS_ORIGIN}`);
  }
});
