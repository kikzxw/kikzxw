const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SAVED_FILE = path.join(DATA_DIR, "saved.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAVED_PER_USER = 50;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,24}$/;
// Improved email validation (RFC 5321: max 254 chars, proper charset)
const EMAIL_PATTERN = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const EMAIL_MAX_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const ROLES = new Set(["admin", "membre"]);

// All valid search payload keys (text fields + integer fields from server.js)
const ALLOWED_PAYLOAD_KEYS = new Set([
  "nom_famille", "prenom",
  "date_naissance", "ville_naissance", "genre",
  "email", "telephone", "nom_utilisateur", "adresse_ip",
  "adresse", "code_postal", "ville",
  "steam_id", "fivem_license", "fivem_license2", "discord_id",
  "xbox_live_id", "live_id",
  "nir", "iban", "bic", "vin_plaque",
  "annee_naissance", "jour_naissance", "mois_naissance",
  "page", "per_page", "flexible",
]);

// ---------------------------------------------------------------------------
// Low-level JSON persistence helpers
// ---------------------------------------------------------------------------

function loadJson(file, fallback) {
  const readArray = (target) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw error;
      throw Object.assign(new Error(`Le fichier de données ${target} est invalide.`, { cause: error }), { code: "INVALID_DATA" });
    }
    if (!Array.isArray(data)) throw Object.assign(new Error(`Le fichier de données ${target} doit contenir un tableau.`), { code: "INVALID_DATA" });
    return data;
  };

  let recovered;
  let corrupted;
  try {
    recovered = readArray(file);
    return recovered;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "INVALID_DATA") throw error;
    if (error.code === "INVALID_DATA") corrupted = `${file}.corrupt-${Date.now()}`;
  }

  const backup = `${file}.bak`;
  try {
    recovered = readArray(backup);
  } catch (error) {
    if (error.code === "ENOENT" && !corrupted) return fallback;
    throw new Error(`Le fichier ${file} ${corrupted ? "est invalide" : "est absent"} et sa sauvegarde ${backup} est indisponible.`, { cause: error });
  }

  if (corrupted) {
    fs.renameSync(file, corrupted);
    fs.chmodSync(corrupted, 0o600);
  }
  const restore = `${file}.restore.tmp`;
  fs.copyFileSync(backup, restore);
  fs.chmodSync(restore, 0o600);
  fs.renameSync(restore, file);
  console.warn(`Données restaurées depuis ${backup}${corrupted ? `; le fichier invalide est conservé sous ${corrupted}` : ""}.`);
  return recovered;
}

function persistJson(file, data) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  const writeDurableFile = (target) => {
    const descriptor = fs.openSync(target, "w", 0o600);
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, contents, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  const tmp = `${file}.tmp`;
  writeDurableFile(tmp);
  if (fs.existsSync(file)) {
    const backupTmp = `${file}.bak.tmp`;
    fs.copyFileSync(file, backupTmp);
    fs.chmodSync(backupTmp, 0o600);
    const backupDescriptor = fs.openSync(backupTmp, "r");
    try { fs.fsyncSync(backupDescriptor); } finally { fs.closeSync(backupDescriptor); }
    fs.renameSync(backupTmp, `${file}.bak`);
  }
  fs.renameSync(tmp, file);
  try {
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch {
    // Directory fsync is not available on every supported platform.
  }
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let users = loadJson(USERS_FILE, []);
let savedSearches = loadJson(SAVED_FILE, []);

// ---------------------------------------------------------------------------
// Platform settings (persisted in settings.json, admin-controlled)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = Object.freeze({
  registrationOpen: true,   // open sign-ups for new accounts
  loginMode: "all",          // "all" | "admins" | "closed"
  searchEnabled: true,       // pause all searches when false
  notice: "",                // optional banner shown on the auth screen
});

const LOGIN_MODES = new Set(["all", "admins", "closed"]);

function loadSettings() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Fichier de réglages illisible (${error.message}) — valeurs par défaut utilisées.`);
    }
    return { ...DEFAULT_SETTINGS };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  return sanitizeSettings(raw);
}

function sanitizeSettings(raw) {
  return {
    registrationOpen: typeof raw.registrationOpen === "boolean" ? raw.registrationOpen : DEFAULT_SETTINGS.registrationOpen,
    loginMode: LOGIN_MODES.has(raw.loginMode) ? raw.loginMode : DEFAULT_SETTINGS.loginMode,
    searchEnabled: typeof raw.searchEnabled === "boolean" ? raw.searchEnabled : DEFAULT_SETTINGS.searchEnabled,
    notice: typeof raw.notice === "string" ? raw.notice.slice(0, 200) : DEFAULT_SETTINGS.notice,
  };
}

let settings = loadSettings();

function getSettings() {
  return { ...settings };
}

function updateSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw authError(400, "Les réglages doivent être un objet JSON valide.");
  }
  const next = { ...settings };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue; // ignore unknown keys
    if (key === "notice") {
      if (typeof value !== "string") throw authError(400, "Le message d'annonce doit être du texte.");
      next.notice = value.slice(0, 200);
      continue;
    }
    if (key === "loginMode") {
      if (!LOGIN_MODES.has(value)) throw authError(400, "Mode de connexion invalide (attendu : all, admins ou closed).");
      next.loginMode = value;
      continue;
    }
    if (typeof value !== "boolean") throw authError(400, `Le réglage « ${key} » doit être un booléen.`);
    next[key] = value;
  }
  persistJson(SETTINGS_FILE, next);
  settings = next;
  return { ...settings };
}
const sessions = new Map(loadJson(SESSIONS_FILE, [])
  .filter((session) => session && /^[a-f0-9]{64}$/.test(session.tokenHash)
    && typeof session.userId === "string" && Number.isFinite(session.expiresAt))
  .map((session) => [session.tokenHash, { userId: session.userId, expiresAt: session.expiresAt }]));

// ---------------------------------------------------------------------------
// Index 1: users by ID (avoids O(n) find() on every request)
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
let usersById = new Map(users.map((u) => [u.id, u]));

function rebuildUsersIndex() {
  usersById = new Map(users.map((u) => [u.id, u]));
}

// ---------------------------------------------------------------------------
// Index 2: saved searches by userId (avoids filter+sort on every listSaved call)
// ---------------------------------------------------------------------------

/** @type {Map<string, object[]>} */
const savedByUser = new Map();

function rebuildSavedIndex() {
  savedByUser.clear();
  for (const entry of savedSearches) {
    if (!savedByUser.has(entry.userId)) savedByUser.set(entry.userId, []);
    savedByUser.get(entry.userId).push(entry);
  }
  for (const [, arr] of savedByUser) {
    arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
rebuildSavedIndex();

// ---------------------------------------------------------------------------
// Session persistence — debounced for renewals, immediate for revocations
// ---------------------------------------------------------------------------

let sessionsDirty = false;
let sessionsPersistTimer = null;

function persistSessions() {
  persistJson(SESSIONS_FILE, [...sessions].map(([tokenHash, session]) => ({ tokenHash, ...session })));
}

/**
 * Schedule a deferred session persist (used for renewals and creations).
 * The actual write happens at most once every 5 seconds, avoiding a disk
 * write on every single request that renews an active session.
 */
function schedulePersistSessions() {
  if (sessionsPersistTimer) return;
  sessionsDirty = true;
  sessionsPersistTimer = setTimeout(() => {
    sessionsPersistTimer = null;
    if (sessionsDirty) {
      persistSessions();
      sessionsDirty = false;
    }
  }, 5_000);
}

// ---------------------------------------------------------------------------
// Auth rate limiting — in-memory per username
// ---------------------------------------------------------------------------

/** @type {Map<string, { count: number, resetAt: number }>} */
const authAttempts = new Map(); // username -> { count, resetAt }

function checkAuthRateLimit(username) {
  const now = Date.now();
  let bucket = authAttempts.get(username);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + 15 * 60 * 1000 };
    authAttempts.set(username, bucket);
  }
  bucket.count++;
  if (bucket.count > 10) {
    // 10 attempts per 15 minutes per username
    throw authError(429, "Trop de tentatives de connexion pour ce compte. Réessayez dans 15 minutes.");
  }
}

function clearAuthRateLimit(username) {
  authAttempts.delete(username);
}

// Periodically remove expired auth attempt buckets to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of authAttempts) {
    if (bucket.resetAt <= now) authAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function authError(status, message) {
  return Object.assign(new Error(message), { status });
}

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, useSalt, 64).toString("hex");
  return { salt: useSalt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateCredentials(username, password) {
  const normalized = String(username || "").trim().toLocaleLowerCase("fr");
  if (!USERNAME_PATTERN.test(normalized)) {
    throw authError(400, "Le nom d'utilisateur doit contenir 3 à 24 caractères (lettres, chiffres, point, tiret ou underscore).");
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw authError(400, `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
  if (password.length > 200) {
    throw authError(400, "Le mot de passe est trop long (200 caractères maximum).");
  }
  return normalized;
}

/**
 * Strip unknown keys and coerce / clamp values in a search-save payload.
 * Only keys present in ALLOWED_PAYLOAD_KEYS and with string/number/boolean
 * values pass through. Strings are truncated to 250 characters.
 */
function sanitizeSavedPayload(payload) {
  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) continue;
    if (typeof value === "string") {
      clean[key] = value.slice(0, 250);
    } else if (typeof value === "number" || typeof value === "boolean") {
      clean[key] = value;
    }
    // Arrays, objects, null, undefined → silently dropped
  }
  return clean;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    searchCount: user.searchCount || 0,
    suspended: Boolean(user.suspended),
  };
}

/**
 * Admin-only view: everything the platform knows about an account
 * (email and profile preferences included).
 */
function adminUser(user) {
  if (!user) return null;
  return {
    ...publicUser(user),
    email: user.email || null,
    lang: user.lang || null,
    timezone: user.timezone || null,
    datefmt: user.datefmt || null,
  };
}

/** Account-scoped details returned only to the authenticated account owner. */
function accountUser(user) {
  if (!user) return null;
  return adminUser(user);
}

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

function createUser(username, password, role = "membre") {
  const normalized = validateCredentials(username, password);
  if (users.some((user) => user.usernameLower === normalized)) {
    throw authError(409, "Ce nom d'utilisateur est déjà pris.");
  }
  if (!ROLES.has(role)) throw authError(400, "Rôle inconnu (attendu : admin ou membre).");
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    username: normalized.split(/[^a-z0-9]+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("") || normalized,
    usernameLower: normalized,
    salt,
    hash,
    role,
    createdAt: new Date().toISOString(),
    searchCount: 0,
  };
  users.push(user);
  usersById.set(user.id, user);
  persistJson(USERS_FILE, users);
  return user;
}

function authenticate(username, password) {
  const normalized = validateCredentials(username, password);
  // Rate-limit before doing any expensive work (e.g. scrypt)
  checkAuthRateLimit(normalized);
  const user = users.find((entry) => entry.usernameLower === normalized);
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    // Do NOT clear the rate-limit counter on failure
    throw authError(401, "Nom d'utilisateur ou mot de passe incorrect.");
  }
  // Successful authentication — clear the failure counter
  clearAuthRateLimit(normalized);
  if (user.suspended) {
    throw authError(403, "Ce compte est suspendu. Contactez un administrateur.");
  }
  return user;
}

function findUserById(id) {
  return usersById.get(id) || null;
}

function listUsers() {
  return users.map(publicUser);
}

function userCount() {
  return users.length;
}

function setRole(actor, targetId, role) {
  if (!ROLES.has(role)) throw authError(400, "Rôle inconnu (attendu : admin ou membre).");
  const target = findUserById(targetId);
  if (!target) throw authError(404, "Utilisateur introuvable.");
  if (actor?.id === targetId && role !== target.role) {
    throw authError(400, "Vous ne pouvez pas modifier votre propre rôle.");
  }
  const admins = users.filter((user) => user.role === "admin");
  if (target.role === "admin" && role !== "admin" && admins.length <= 1) {
    throw authError(400, "Impossible de rétrograder le dernier administrateur.");
  }
  target.role = role;
  persistJson(USERS_FILE, users);
  return publicUser(target);
}

function deleteUser(actor, targetId) {
  const target = findUserById(targetId);
  if (!target) throw authError(404, "Utilisateur introuvable.");
  if (target.id === actor.id) throw authError(400, "Vous ne pouvez pas supprimer votre propre compte.");
  if (target.role === "admin" && users.filter((user) => user.role === "admin").length <= 1) {
    throw authError(400, "Impossible de supprimer le dernier administrateur.");
  }
  users = users.filter((user) => user.id !== targetId);
  usersById.delete(targetId);
  savedSearches = savedSearches.filter((entry) => entry.userId !== targetId);
  savedByUser.delete(targetId);
  for (const [token, session] of sessions) {
    if (session.userId === targetId) sessions.delete(token);
  }
  // Immediate persist — security-sensitive deletion
  persistSessions();
  persistJson(USERS_FILE, users);
  persistJson(SAVED_FILE, savedSearches);
  return publicUser(target);
}

function incrementSearchCount(userId) {
  const user = findUserById(userId);
  if (!user) return;
  user.searchCount = (user.searchCount || 0) + 1;
  persistJson(USERS_FILE, users);
}

// ---------------------------------------------------------------------------
// Admin: full account visibility and control
// ---------------------------------------------------------------------------

/** Number of live sessions for one user. */
function sessionCountFor(userId) {
  const now = Date.now();
  let count = 0;
  for (const session of sessions.values()) {
    if (session.userId === userId && session.expiresAt > now) count += 1;
  }
  return count;
}

/** Admin list: every field of every account, plus its live session count. */
function listUsersForAdmin() {
  return users.map((user) => ({
    ...adminUser(user),
    sessions: sessionCountFor(user.id),
    savedCount: listSaved(user.id).length,
  }));
}

/** Full dossier on one account: profile, live sessions and saved searches. */
function adminUserDetail(targetId) {
  const target = findUserById(targetId);
  if (!target) throw authError(404, "Utilisateur introuvable.");
  const now = Date.now();
  const liveSessions = [];
  for (const session of sessions.values()) {
    if (session.userId === targetId && session.expiresAt > now) {
      liveSessions.push({ expiresAt: new Date(session.expiresAt).toISOString() });
    }
  }
  return {
    user: adminUser(target),
    sessions: liveSessions,
    saved: listSaved(targetId),
    stats: {
      searches: target.searchCount || 0,
      savedSearches: listSaved(targetId).length,
      sessions: liveSessions.length,
    },
  };
}

/** Suspend or reinstate an account. Suspended users are logged out at once. */
function setSuspended(actor, targetId, suspended) {
  if (typeof suspended !== "boolean") throw authError(400, "Le champ « suspended » doit être un booléen.");
  const target = findUserById(targetId);
  if (!target) throw authError(404, "Utilisateur introuvable.");
  if (target.id === actor.id) throw authError(400, "Vous ne pouvez pas suspendre votre propre compte.");
  if (suspended && target.role === "admin" && users.filter((user) => user.role === "admin").length <= 1) {
    throw authError(400, "Impossible de suspendre le dernier administrateur.");
  }
  target.suspended = suspended;
  if (suspended) {
    for (const [tokenHash, session] of sessions) {
      if (session.userId === targetId) sessions.delete(tokenHash);
    }
    persistSessions();
  }
  persistJson(USERS_FILE, users);
  return adminUser(target);
}

/** Revoke every live session of one user (force logout). Returns the count. */
function revokeUserSessions(targetId) {
  const target = findUserById(targetId);
  if (!target) throw authError(404, "Utilisateur introuvable.");
  let revoked = 0;
  for (const [tokenHash, session] of sessions) {
    if (session.userId === targetId) {
      sessions.delete(tokenHash);
      revoked += 1;
    }
  }
  if (revoked) persistSessions();
  return revoked;
}

/**
 * Revoke every session except `keepToken` (the acting admin's own session).
 * Returns the number of sessions revoked.
 */
function revokeAllSessions(keepToken) {
  const keepHash = typeof keepToken === "string" && /^[a-f0-9]{64}$/.test(keepToken)
    ? crypto.createHash("sha256").update(keepToken).digest("hex")
    : null;
  let revoked = 0;
  for (const tokenHash of sessions.keys()) {
    if (keepHash && tokenHash === keepHash) continue;
    sessions.delete(tokenHash);
    revoked += 1;
  }
  if (revoked) persistSessions();
  return revoked;
}

function stats() {
  return {
    users: users.length,
    admins: users.filter((user) => user.role === "admin").length,
    membres: users.filter((user) => user.role === "membre").length,
    suspended: users.filter((user) => user.suspended).length,
    savedSearches: savedSearches.length,
    sessions: sessions.size,
    searches: users.reduce((sum, user) => sum + (user.searchCount || 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  sessions.set(tokenHash, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  // Creation — use debounced persist (a burst of registrations shouldn't
  // thrash the disk; the 5 s window is acceptable here).
  schedulePersistSessions();
  return token;
}

function getSession(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const session = sessions.get(tokenHash);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt <= now) {
    sessions.delete(tokenHash);
    // Immediate persist — expired session must not be reused
    persistSessions();
    return null;
  }
  if (session.expiresAt - now < SESSION_TTL_MS - 60 * 60 * 1000) {
    session.expiresAt = now + SESSION_TTL_MS;
    // Renewal — debounced; a 5 s delay is fine for a sliding expiry
    schedulePersistSessions();
  }
  const user = findUserById(session.userId);
  if (!user) {
    sessions.delete(tokenHash);
    // Immediate persist — orphan session removed for security
    persistSessions();
    return null;
  }
  if (user.suspended) {
    // Suspended accounts lose their sessions immediately.
    sessions.delete(tokenHash);
    persistSessions();
    return null;
  }
  return { token, user };
}

function revokeSession(token) {
  if (!token) return;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  if (sessions.delete(tokenHash)) {
    // Immediate persist — revocation must be durable immediately
    persistSessions();
  }
}

function purgeExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) persistSessions();
}

// Purge on startup, then every 15 minutes (more aggressive than before)
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 15 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Saved searches
// ---------------------------------------------------------------------------

function listSaved(userId) {
  // O(1) lookup via index instead of O(n) filter + sort
  return savedByUser.get(userId) || [];
}

function addSaved(userId, label, payload) {
  const text = String(label || "").trim().slice(0, 80);
  if (!text) throw authError(400, "Le nom de la recherche enregistrée est requis.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw authError(400, "Les critères de la recherche sont invalides.");
  }
  const owned = listSaved(userId);
  if (owned.length >= MAX_SAVED_PER_USER) {
    throw authError(400, `Limite de ${MAX_SAVED_PER_USER} recherches enregistrées atteinte.`);
  }
  // Sanitize payload: only allow known keys with safe value types
  const cleanPayload = sanitizeSavedPayload(payload);
  const entry = {
    id: crypto.randomUUID(),
    userId,
    label: text,
    payload: cleanPayload,
    createdAt: new Date().toISOString(),
  };
  savedSearches.push(entry);
  // Update index: insert at front (entries are kept newest-first)
  if (!savedByUser.has(userId)) savedByUser.set(userId, []);
  savedByUser.get(userId).unshift(entry);
  persistJson(SAVED_FILE, savedSearches);
  return entry;
}

function removeSaved(userId, id) {
  const entry = savedSearches.find((item) => item.id === id && item.userId === userId);
  if (!entry) throw authError(404, "Recherche enregistrée introuvable.");
  savedSearches = savedSearches.filter((item) => item.id !== id);
  // Update index
  const userEntries = savedByUser.get(userId);
  if (userEntries) {
    const idx = userEntries.findIndex((item) => item.id === id);
    if (idx !== -1) userEntries.splice(idx, 1);
    if (userEntries.length === 0) savedByUser.delete(userId);
  }
  persistJson(SAVED_FILE, savedSearches);
  return entry;
}

// ---------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------

function updateUserProfile(userId, { email, lang, timezone, datefmt }) {
  const user = findUserById(userId);
  if (!user) throw authError(404, "Utilisateur introuvable.");
  let nextEmail = user.email || null;
  let nextLang = user.lang || null;
  let nextTimezone = user.timezone || null;
  let nextDatefmt = user.datefmt || null;
  if (email !== undefined) {
    if (email !== null && email !== "" && typeof email !== "string") {
      throw authError(400, "Email invalide.");
    }
    if (email) {
      if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
        throw authError(400, "Email invalide.");
      }
    }
    nextEmail = email || null;
  }
  if (lang !== undefined) {
    if (!["fr", "en"].includes(lang)) throw authError(400, "Langue invalide.");
    nextLang = lang;
  }
  if (timezone !== undefined) {
    if (typeof timezone !== "string" || timezone.length > 64) throw authError(400, "Fuseau horaire invalide.");
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); }
    catch { throw authError(400, "Fuseau horaire invalide."); }
    nextTimezone = timezone;
  }
  if (datefmt !== undefined) {
    if (!["fr-FR", "ISO", "US"].includes(datefmt)) throw authError(400, "Format de date invalide.");
    nextDatefmt = datefmt;
  }
  user.email = nextEmail;
  user.lang = nextLang;
  user.timezone = nextTimezone;
  user.datefmt = nextDatefmt;
  persistJson(USERS_FILE, users);
  return publicUser(user);
}

function changePassword(userId, currentPassword, newPassword) {
  const user = findUserById(userId);
  if (!user) throw authError(404, "Utilisateur introuvable.");
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    throw authError(400, "Champs requis manquants.");
  }
  if (currentPassword.length > 200) throw authError(400, "Le mot de passe actuel est trop long.");
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw authError(400, `Le nouveau mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
  if (newPassword.length > 200) throw authError(400, "Le mot de passe est trop long (200 caractères maximum).");
  if (!verifyPassword(currentPassword, user.salt, user.hash)) {
    throw authError(401, "Mot de passe actuel incorrect.");
  }
  const { salt, hash } = hashPassword(newPassword);
  user.salt = salt;
  user.hash = hash;
  persistJson(USERS_FILE, users);
  return publicUser(user);
}

// Admin-only: resets a user's password without requiring their current password.
function resetPassword(targetId, newPassword) {
  const user = findUserById(targetId);
  if (!user) throw authError(404, "Utilisateur introuvable.");
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
    throw authError(400, `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
  if (newPassword.length > 200) {
    throw authError(400, "Le mot de passe est trop long (200 caractères maximum).");
  }
  const { salt, hash } = hashPassword(newPassword);
  user.salt = salt;
  user.hash = hash;
  // Invalidate all existing sessions for this user after a password reset.
  for (const [token, session] of sessions) {
    if (session.userId === targetId) sessions.delete(token);
  }
  // Immediate persist — security-sensitive operation
  persistSessions();
  persistJson(USERS_FILE, users);
  return publicUser(user);
}

function deleteOwnAccount(userId) {
  const user = findUserById(userId);
  if (!user) throw authError(404, "Utilisateur introuvable.");
  users = users.filter((u) => u.id !== userId);
  usersById.delete(userId);
  savedSearches = savedSearches.filter((entry) => entry.userId !== userId);
  savedByUser.delete(userId);
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token);
  }
  // Immediate persist — account deletion must be durable immediately
  persistSessions();
  persistJson(USERS_FILE, users);
  persistJson(SAVED_FILE, savedSearches);
  return publicUser(user);
}

// ---------------------------------------------------------------------------
// Load-time integrity check
// ---------------------------------------------------------------------------

// Warn about users whose stored hash has an unexpected length.
// scrypt(64 bytes) → 128 hex chars. An odd-length or wrong-length hash would
// make timingSafeEqual always return false, locking that user out silently.
(function checkHashIntegrity() {
  const EXPECTED_HASH_HEX_LENGTH = 128; // 64 bytes × 2
  for (const user of users) {
    if (typeof user.hash !== "string" || user.hash.length !== EXPECTED_HASH_HEX_LENGTH) {
      console.warn(
        `store: utilisateur '${user.username}' (id=${user.id}) a un hash de longueur ${user.hash?.length ?? "indéfinie"} (attendu ${EXPECTED_HASH_HEX_LENGTH}). ` +
        `Ce compte ne peut pas s'authentifier. Réinitialisez son mot de passe via l'API d'administration ou recréez le compte.`,
      );
    }
  }
}());

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ROLES,
  publicUser,
  adminUser,
  accountUser,
  createUser,
  userCount,
  authenticate,
  findUserById,
  listUsers,
  listUsersForAdmin,
  adminUserDetail,
  setRole,
  setSuspended,
  revokeUserSessions,
  revokeAllSessions,
  deleteUser,
  incrementSearchCount,
  stats,
  getSettings,
  updateSettings,
  createSession,
  getSession,
  revokeSession,
  listSaved,
  addSaved,
  removeSaved,
  updateUserProfile,
  changePassword,
  resetPassword,
  deleteOwnAccount,
  // Exported for testing and potential middleware use
  checkAuthRateLimit,
  clearAuthRateLimit,
};
