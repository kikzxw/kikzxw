const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const searchResponseModule = import("./search-response.mjs");
const store = require("./store");

const SESSION_COOKIE = "rt_session";


const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.resolve(__dirname, "..");
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const TLS_CERT_PATH = process.env.TLS_CERT || "";
const TLS_KEY_PATH = process.env.TLS_KEY || "";
const RATE_LIMIT_SEARCH = Math.max(1, Number(process.env.RATE_LIMIT_SEARCH || 20));
const MAX_REQUEST_SIZE = 2 * 1024;
const MAX_SEARCH_SIZE = 16 * 1024;
const SEARCH_ENDPOINT = process.env.SEARCH_ENDPOINT || atob("aHR0cHM6Ly9hcGkuYnJpeGh1Yi5ydS9hcGkvdjEvc2VhcmNo");
const SEARCH_TIMEOUT_MS = 20_000;
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

function sendJson(response, statusCode, payload, extraHeaders) {
  response.writeHead(statusCode, {
    "Content-Type": MIME_TYPES[".json"],
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...(extraHeaders || {}),
  });
  response.end(JSON.stringify(payload));
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

function challengeUnauthorized(response) {
  sendJson(response, 401, { error: "Authentification requise." }, { "WWW-Authenticate": 'Basic realm="KIKZXW", charset="UTF-8"' });
}

const rateBuckets = new Map();

function isRateLimited(request, limitPerMinute, scope = "default") {
  const now = Date.now();
  const ip = clientIp(request);
  const key = `${scope}:${ip}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (rateBuckets.size >= 10_000) {
      for (const [entryKey, entry] of rateBuckets) {
        if (entry.resetAt <= now) rateBuckets.delete(entryKey);
      }
    }
    bucket = { count: 0, resetAt: now + 60_000 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count > limitPerMinute;
}


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

async function handleSearch(request, response) {
  const session = readSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Connexion requise pour effectuer une recherche." });
    return;
  }
  const userId = session.user.id;
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

function sessionCookie(token) {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=604800"];
  if (useTls) parts.push("Secure");
  return parts.join("; ");
}

function clearedSessionCookie() {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (useTls) parts.push("Secure");
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
  if (isRateLimited(request, 10, "register")) {
    sendJson(response, 429, { error: "Trop de tentatives de création de compte. Réessayez dans une minute." });
    return;
  }
  let body;
  try {
    body = await readAuthBody(request);
    const user = store.createUser(body.username, body.password);
    const token = store.createSession(user.id);
    response.setHeader("Set-Cookie", sessionCookie(token));
    sendJson(response, 201, { user: store.publicUser(user), firstUser: user.role === "admin" });
  } catch (error) {
    sendAuthError(response, error);
  }
}

async function handleLogin(request, response) {
  if (isRateLimited(request, 15, "login")) {
    sendJson(response, 429, { error: "Trop de tentatives de connexion. Réessayez dans une minute." });
    return;
  }
  let body;
  try {
    body = await readAuthBody(request);
    const user = store.authenticate(body.username, body.password);
    const token = store.createSession(user.id);
    response.setHeader("Set-Cookie", sessionCookie(token));
    sendJson(response, 200, { user: store.publicUser(user) });
  } catch (error) {
    sendAuthError(response, error);
  }
}

function handleLogout(request, response) {
  const session = readSession(request);
  if (session) store.revokeSession(session.token);
  response.setHeader("Set-Cookie", clearedSessionCookie());
  sendJson(response, 200, { ok: true });
}

function handleMe(request, response) {
  const session = readSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Session inactive ou expirée." });
    return;
  }
  sendJson(response, 200, { user: store.publicUser(session.user) });
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

  if (request.method === "GET") {
    sendJson(response, 200, { users: store.listUsers() });
    return;
  }

  const targetMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})$/.exec(pathname);
  if (!targetMatch) {
    sendJson(response, 404, { error: "Endpoint inconnu." });
    return;
  }
  const targetId = targetMatch[1];

  try {
    if (request.method === "PATCH") {
      const body = await readAuthBody(request);
      const user = store.setRole(session.user, targetId, body.role);
      sendJson(response, 200, { user });
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
    if (isRateLimited(request, 30, "saved")) {
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

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: MIME_TYPES[".html"] }],
  ["/index.html", { file: "index.html", type: MIME_TYPES[".html"] }],
  ["/styles.css", { file: "styles.css", type: MIME_TYPES[".css"] }],
  ["/app.js", { file: "app.js", type: MIME_TYPES[".js"] }],
]);

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
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  fs.readFile(path.join(ROOT, asset.file), (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": pathname === "/" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    });
    response.end(content);
  });
}

function handleRequest(request, response) {
  if (!isAuthorized(request)) {
    challengeUnauthorized(response);
    return;
  }
  let pathname = "";
  try {
    pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  } catch {
    sendJson(response, 400, { error: "Requête invalide." });
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
  } else if (pathname === "/api/admin/stats") {
    if (request.method !== "GET") sendJson(response, 405, { error: "Méthode non autorisée." });
    else handleAdminStats(request, response);
  } else if (pathname === "/api/admin/users" || pathname.startsWith("/api/admin/users/")) {
    handleAdminUsers(request, response, pathname);
  } else if (pathname === "/api/saved" || pathname.startsWith("/api/saved/")) {
    handleSaved(request, response, pathname);
  } else if (request.method === "POST" && pathname === "/api/search") {
    if (isRateLimited(request, RATE_LIMIT_SEARCH, "search")) {
      sendJson(response, 429, { error: "Trop de requêtes. Réessayez dans une minute." });
      return;
    }
    handleSearch(request, response);
  } else if (request.method === "GET") {
    serveStatic(request, response);
  } else if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "Endpoint inconnu." });
  } else {
    sendJson(response, 405, { error: "Méthode non autorisée." });
  }
}

const server = http.createServer(handleRequest);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

const useTls = Boolean(TLS_CERT_PATH && TLS_KEY_PATH);
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

publicServer.listen(PORT, HOST, () => {
  const scheme = useTls ? "https" : "http";
  console.log(`KIKZXW est disponible sur ${scheme}://${HOST}:${PORT}`);
  if (!AUTH_USER && !AUTH_PASS) {
    console.log("Attention : aucune authentification n'est configurée (variables AUTH_USER / AUTH_PASS).");
  }
});
