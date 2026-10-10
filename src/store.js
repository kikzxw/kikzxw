const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SAVED_FILE = path.join(DATA_DIR, "saved.json");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAVED_PER_USER = 50;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,24}$/;
const MIN_PASSWORD_LENGTH = 8;
const ROLES = new Set(["admin", "membre"]);

function loadJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data ?? fallback;
  } catch {
    return fallback;
  }
}

function persistJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

let users = loadJson(USERS_FILE, []);
let savedSearches = loadJson(SAVED_FILE, []);
const sessions = new Map();

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

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    searchCount: user.searchCount || 0,
  };
}

function createUser(username, password) {
  const normalized = validateCredentials(username, password);
  if (users.some((user) => user.usernameLower === normalized)) {
    throw authError(409, "Ce nom d'utilisateur est déjà pris.");
  }
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    username: normalized.split(/[^a-z0-9]+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("") || normalized,
    usernameLower: normalized,
    salt,
    hash,
    role: users.length === 0 ? "admin" : "membre",
    createdAt: new Date().toISOString(),
    searchCount: 0,
  };
  users.push(user);
  persistJson(USERS_FILE, users);
  return user;
}

function authenticate(username, password) {
  const normalized = validateCredentials(username, password);
  const user = users.find((entry) => entry.usernameLower === normalized);
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    throw authError(401, "Nom d'utilisateur ou mot de passe incorrect.");
  }
  return user;
}

function findUserById(id) {
  return users.find((user) => user.id === id) || null;
}

function listUsers() {
  return users.map(publicUser);
}

function setRole(actor, targetId, role) {
  if (!ROLES.has(role)) throw authError(400, "Rôle inconnu (attendu : admin ou membre).");
  const target = findUserById(targetId);
  if (!target) throw authError(404, "Utilisateur introuvable.");
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
  savedSearches = savedSearches.filter((entry) => entry.userId !== targetId);
  for (const [token, session] of sessions) {
    if (session.userId === targetId) sessions.delete(token);
  }
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

function stats() {
  return {
    users: users.length,
    admins: users.filter((user) => user.role === "admin").length,
    membres: users.filter((user) => user.role === "membre").length,
    savedSearches: savedSearches.length,
    sessions: sessions.size,
    searches: users.reduce((sum, user) => sum + (user.searchCount || 0), 0),
  };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  const user = findUserById(session.userId);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  return { token, user };
}

function revokeSession(token) {
  if (token) sessions.delete(token);
}

function purgeExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function listSaved(userId) {
  return savedSearches
    .filter((entry) => entry.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  const entry = {
    id: crypto.randomUUID(),
    userId,
    label: text,
    payload,
    createdAt: new Date().toISOString(),
  };
  savedSearches.push(entry);
  persistJson(SAVED_FILE, savedSearches);
  return entry;
}

function removeSaved(userId, id) {
  const entry = savedSearches.find((item) => item.id === id && item.userId === userId);
  if (!entry) throw authError(404, "Recherche enregistrée introuvable.");
  savedSearches = savedSearches.filter((item) => item.id !== id);
  persistJson(SAVED_FILE, savedSearches);
  return entry;
}

setInterval(purgeExpiredSessions, 30 * 60 * 1000).unref();

module.exports = {
  ROLES,
  publicUser,
  createUser,
  authenticate,
  findUserById,
  listUsers,
  setRole,
  deleteUser,
  incrementSearchCount,
  stats,
  createSession,
  getSession,
  revokeSession,
  listSaved,
  addSaved,
  removeSaved,
};
