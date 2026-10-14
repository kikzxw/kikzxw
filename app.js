const views = ["overview", "search", "history", "settings", "admin"];
const sidebarToggle = document.querySelector("#sidebar-toggle");
const sidebarPreferenceKey = "kikzxw.sidebar-collapsed";
const userMenuTrigger = document.querySelector("#user-menu-trigger");
const userMenuDropdown = document.querySelector("#user-menu-dropdown");
const userMenu = document.querySelector("#user-menu");
const viewTitles = {
  overview: "Tableau de bord",
  search: "Recherche",
  history: "Historique",
  settings: "Paramètres",
  admin: "Administration",
};
const activity = [];
let activeSearch = null;
let currentUser = null;
let currentResults = null;
let savedSearches = [];
let authMode = "login";

/* ---------- Utilities ---------- */
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/* ---------- Sidebar ---------- */
function setSidebarCollapsed(collapsed, persist = true) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const label = collapsed ? "Déployer la barre latérale" : "Réduire la barre latérale";
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("aria-label", label);
  sidebarToggle.title = label;
  if (persist) {
    try {
      window.localStorage.setItem(sidebarPreferenceKey, String(collapsed));
    } catch {
      // La préférence reste appliquée dans l'onglet si le stockage est indisponible.
    }
  }
}

/* ---------- Toast System ---------- */
const _toastActiveMessages = new Set();

function showToast(message, kind = "info") {
  // Avoid duplicate messages
  if (_toastActiveMessages.has(message)) return;

  let host = document.querySelector("#toast-host");
  if (!host) {
    host = element("div", "toast-host");
    host.id = "toast-host";
    document.body.append(host);
  }

  // Enforce max 5 toasts
  const existing = host.querySelectorAll(".toast");
  if (existing.length >= 5) {
    const oldest = existing[0];
    _toastActiveMessages.delete(oldest.dataset.message || "");
    oldest.remove();
  }

  const duration = kind === "error" ? 5000 : 3200;

  const toast = element("div", `toast toast-${kind} toast-enter`);
  toast.dataset.message = message;
  _toastActiveMessages.add(message);

  const msgSpan = element("span", "toast-message", message);
  const closeBtn = element("button", "toast-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Fermer la notification");
  toast.append(msgSpan, closeBtn);
  host.append(toast);

  // Play sound if preference enabled
  try {
    const settings = getSettings();
    if (settings.toastSound) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = kind === "error" ? 220 : kind === "success" ? 660 : 440;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    }
  } catch {
    // Audio context unavailable
  }

  // Remove enter class after paint
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.remove("toast-enter"));
  });

  const dismiss = () => {
    if (!toast.isConnected) return;
    _toastActiveMessages.delete(message);
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 350);
  };

  closeBtn.addEventListener("click", dismiss);
  const autoTimer = setTimeout(dismiss, duration);
  closeBtn.addEventListener("click", () => clearTimeout(autoTimer), { once: true });
}

/* ---------- Native Dialog: confirmDialog ---------- */
function ensureConfirmDialog() {
  let dlg = document.querySelector("#confirm-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "confirm-dialog";
  dlg.className = "native-dialog confirm-dialog";
  dlg.innerHTML = `
    <div class="dialog-inner">
      <p class="dialog-message" id="confirm-dialog-message"></p>
      <div class="dialog-actions">
        <button type="button" class="button button-ghost" id="confirm-dialog-cancel">Annuler</button>
        <button type="button" class="button button-danger" id="confirm-dialog-ok">Confirmer</button>
      </div>
    </div>`;
  document.body.append(dlg);
  return dlg;
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    const dlg = ensureConfirmDialog();
    dlg.querySelector("#confirm-dialog-message").textContent = message;
    const ok = dlg.querySelector("#confirm-dialog-ok");
    const cancel = dlg.querySelector("#confirm-dialog-cancel");
    const finish = (result) => {
      dlg.close();
      resolve(result);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    dlg.onclose = () => resolve(false);
    dlg.showModal();
  });
}

/* ---------- Native Dialog: saveSearchDialog ---------- */
function ensureSaveSearchDialog() {
  let dlg = document.querySelector("#save-search-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "save-search-dialog";
  dlg.className = "native-dialog save-search-dialog";
  dlg.innerHTML = `
    <div class="dialog-inner">
      <label class="dialog-label" for="save-search-dialog-input">Nom de cette recherche enregistrée</label>
      <input id="save-search-dialog-input" class="dialog-input" type="text" autocomplete="off" />
      <div class="dialog-actions">
        <button type="button" class="button button-ghost" id="save-search-dialog-cancel">Annuler</button>
        <button type="button" class="button" id="save-search-dialog-ok">Enregistrer</button>
      </div>
    </div>`;
  document.body.append(dlg);
  return dlg;
}

function promptDialog(defaultValue) {
  return new Promise((resolve) => {
    const dlg = ensureSaveSearchDialog();
    const input = dlg.querySelector("#save-search-dialog-input");
    const ok = dlg.querySelector("#save-search-dialog-ok");
    const cancel = dlg.querySelector("#save-search-dialog-cancel");
    input.value = defaultValue || "";
    const finish = (result) => {
      dlg.close();
      resolve(result);
    };
    ok.onclick = () => finish(input.value);
    cancel.onclick = () => finish(null);
    dlg.onclose = () => resolve(null);
    // Submit on Enter
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); finish(input.value); } };
    dlg.showModal();
    input.focus();
    input.select();
  });
}

/* ---------- Loading Bar ---------- */
let _loadingBarTimer = null;
let _loadingBarProgress = 0;
let _loadingBarActive = 0;

function ensureLoadingBar() {
  let bar = document.querySelector("#loading-bar");
  if (bar) return bar;
  bar = element("div", "loading-bar");
  bar.id = "loading-bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-hidden", "true");
  document.body.prepend(bar);
  return bar;
}

function startLoadingBar() {
  _loadingBarActive += 1;
  const bar = ensureLoadingBar();
  if (_loadingBarActive === 1) {
    _loadingBarProgress = 0;
    bar.style.width = "0%";
    bar.classList.add("active");
    _advanceLoadingBar();
  }
}

function _advanceLoadingBar() {
  const bar = ensureLoadingBar();
  const step = Math.random() * 12 + 3;
  _loadingBarProgress = Math.min(_loadingBarProgress + step, 85);
  bar.style.width = `${_loadingBarProgress}%`;
  if (_loadingBarProgress < 85) {
    _loadingBarTimer = setTimeout(_advanceLoadingBar, 200 + Math.random() * 400);
  }
}

function stopLoadingBar() {
  _loadingBarActive = Math.max(0, _loadingBarActive - 1);
  if (_loadingBarActive > 0) return;
  clearTimeout(_loadingBarTimer);
  const bar = ensureLoadingBar();
  bar.style.width = "100%";
  setTimeout(() => {
    bar.classList.remove("active");
    bar.style.width = "0%";
    _loadingBarProgress = 0;
  }, 300);
}

/* ---------- Scroll-to-top button ---------- */
function ensureScrollTopBtn() {
  let btn = document.querySelector("#scroll-top-btn");
  if (btn) return btn;
  btn = element("button", "scroll-top-btn");
  btn.id = "scroll-top-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", "Remonter en haut de la page");
  btn.title = "Retour en haut";
  btn.textContent = "↑";
  btn.setAttribute("aria-hidden", "true");
  document.body.append(btn);
  return btn;
}

function initScrollTopBtn() {
  const btn = ensureScrollTopBtn();
  btn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  window.addEventListener("scroll", () => {
    const visible = window.scrollY > 400;
    btn.classList.toggle("visible", visible);
    btn.setAttribute("aria-hidden", String(!visible));
  }, { passive: true });
}

/* ---------- Offline / Online detection ---------- */
let _offlineBanner = null;

function ensureOfflineBanner() {
  if (_offlineBanner) return _offlineBanner;
  _offlineBanner = element("div", "offline-banner hidden");
  _offlineBanner.id = "offline-banner";
  _offlineBanner.setAttribute("role", "alert");
  _offlineBanner.textContent = "⚠ Connexion perdue — certaines fonctionnalités sont indisponibles.";
  document.body.prepend(_offlineBanner);
  return _offlineBanner;
}

function initNetworkDetection() {
  const banner = ensureOfflineBanner();
  window.addEventListener("offline", () => {
    banner.classList.remove("hidden");
    showToast("Connexion perdue — mode hors ligne.", "warn");
  });
  window.addEventListener("online", () => {
    banner.classList.add("hidden");
    showToast("Connexion rétablie.", "success");
  });
  if (!navigator.onLine) banner.classList.remove("hidden");
}

/* ---------- Keyboard Shortcuts ---------- */
function ensureShortcutsDialog() {
  let dlg = document.querySelector("#shortcuts-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "shortcuts-dialog";
  dlg.className = "native-dialog shortcuts-dialog";
  dlg.innerHTML = `
    <div class="dialog-inner">
      <h2 class="dialog-title">Raccourcis clavier</h2>
      <ul class="shortcuts-list">
        <li><kbd>Ctrl</kbd>+<kbd>K</kbd> / <kbd>⌘K</kbd> — Recherche rapide</li>
        <li><kbd>Alt</kbd>+<kbd>1</kbd> — Vue Tableau de bord</li>
        <li><kbd>Alt</kbd>+<kbd>2</kbd> — Vue Recherche</li>
        <li><kbd>Alt</kbd>+<kbd>3</kbd> — Vue Historique</li>
        <li><kbd>Alt</kbd>+<kbd>4</kbd> — Vue Paramètres</li>
        <li><kbd>Échap</kbd> — Fermer menu / dialog</li>
        <li><kbd>Ctrl</kbd>+<kbd>/</kbd> — Afficher les raccourcis</li>
        <li><kbd>?</kbd> — Afficher les raccourcis (hors champ texte)</li>
      </ul>
      <div class="dialog-actions">
        <button type="button" class="button" id="shortcuts-dialog-close">Fermer</button>
      </div>
    </div>`;
  document.body.append(dlg);
  dlg.querySelector("#shortcuts-dialog-close").addEventListener("click", () => dlg.close());
  return dlg;
}

function handleKeyboardShortcuts(e) {
  const tag = document.activeElement?.tagName?.toLowerCase();
  const inInput = ["input", "textarea", "select"].includes(tag) || document.activeElement?.isContentEditable;

  // Ctrl+K / Cmd+K — go to search, focus search field
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    showView("search");
    setTimeout(() => {
      const field = document.querySelector("#search-field-filter");
      if (field) field.focus();
    }, 50);
    return;
  }

  // Ctrl+/ — show shortcuts
  if ((e.ctrlKey || e.metaKey) && e.key === "/") {
    e.preventDefault();
    ensureShortcutsDialog().showModal();
    return;
  }

  // Alt+1..4 — switch views
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const viewMap = { "1": "overview", "2": "search", "3": "history", "4": "settings" };
    if (viewMap[e.key]) {
      e.preventDefault();
      showView(viewMap[e.key]);
      return;
    }
  }

  // Escape — close user menu, close open dialogs
  if (e.key === "Escape") {
    // Dialogs handle their own Escape; just close user menu here
    if (!userMenuDropdown.classList.contains("hidden")) {
      closeUserMenu();
      userMenuTrigger.focus();
    }
    return;
  }

  // ? — show shortcuts when not in input
  if (e.key === "?" && !inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
    ensureShortcutsDialog().showModal();
    return;
  }
}

/* ---------- 3D Effects & Mouse Tracking ---------- */
let mouseX = 0.5;
let mouseY = 0.5;
let scrollY = 0;
let rafId = null;
let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function init3DEffects() {
  if (reducedMotion) return;

  const root = document.documentElement;

  document.addEventListener("mousemove", (e) => {
    mouseX = e.clientX / window.innerWidth;
    mouseY = e.clientY / window.innerHeight;
    root.style.setProperty("--mouse-x", `${mouseX * 100}%`);
    root.style.setProperty("--mouse-y", `${mouseY * 100}%`);
  });

  let ticking = false;
  window.addEventListener("scroll", () => {
    scrollY = window.scrollY;
    root.style.setProperty("--scroll-y", scrollY);
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(() => {
        updateScrollProgress();
        updateParallax();
        updateScrollReveal();
        ticking = false;
      });
    }
  }, { passive: true });

  const progressBar = document.createElement("div");
  progressBar.className = "scroll-progress";
  document.body.appendChild(progressBar);

  document.querySelectorAll(".tilt-3d").forEach((el) => {
    el.addEventListener("mousemove", (e) => handleTilt(e, el));
    el.addEventListener("mouseleave", () => resetTilt(el));
  });

  document.querySelectorAll(".magnetic").forEach((btn) => {
    btn.addEventListener("mousemove", (e) => handleMagnetic(e, btn));
    btn.addEventListener("mouseleave", () => resetMagnetic(btn));
  });

  // Avoid injecting blurred blobs and SVG turbulence filters into every panel.
  initScrollReveal();
}

function updateScrollProgress() {
  const progressBar = document.querySelector(".scroll-progress");
  if (!progressBar) return;
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  const progress = scrollHeight > 0 ? scrollY / scrollHeight : 0;
  progressBar.style.transform = `scaleX(${progress})`;
}

function updateParallax() {
  document.querySelectorAll(".parallax-layer").forEach((layer) => {
    const depth = parseFloat(layer.dataset.depth) || 1;
    const speed = depth * 0.1;
    const y = scrollY * speed;
    layer.style.transform = `translate3d(0, ${y}px, 0)`;
  });

  document.querySelectorAll(".welcome-hero, .page-intro").forEach((hero) => {
    const rect = hero.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    const offset = (window.innerHeight / 2 - rect.top) * 0.15;
    hero.style.setProperty("--parallax-offset", `${offset}px`);
  });
}

/* BUG FIX #1: handleTilt — logique Math.max/Math.min corrigée */
function handleTilt(e, el) {
  const rect = el.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const deltaX = (e.clientX - centerX) / (rect.width / 2);
  const deltaY = (e.clientY - centerY) / (rect.height / 2);
  const maxTilt = 8;
  const tiltX = Math.max(-maxTilt, Math.min(maxTilt, deltaY * maxTilt));
  const tiltY = Math.max(-maxTilt, Math.min(maxTilt, -deltaX * maxTilt));
  el.style.setProperty("--tilt-x", `${tiltY}deg`);
  el.style.setProperty("--tilt-y", `${tiltX}deg`);
}

function resetTilt(el) {
  el.style.setProperty("--tilt-x", "0deg");
  el.style.setProperty("--tilt-y", "0deg");
}

function handleMagnetic(e, btn) {
  const rect = btn.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const deltaX = (e.clientX - centerX) * 0.3;
  const deltaY = (e.clientY - centerY) * 0.3;
  btn.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(1.02)`;
}

function resetMagnetic(btn) {
  btn.style.transform = "translate(0, 0) scale(1)";
}

function addLiquidBlobs() {
  const heroSections = document.querySelectorAll(".welcome-hero, .page-intro");
  heroSections.forEach((section, i) => {
    if (section.querySelector(".liquid-blob")) return;
    const blob = document.createElement("div");
    blob.className = "liquid-blob";
    blob.style.cssText = `
      width: ${300 + i * 50}px;
      height: ${300 + i * 50}px;
      top: ${20 + i * 10}%;
      left: ${i % 2 === 0 ? "10%" : "80%"};
      background: ${i % 2 === 0 ? "radial-gradient(circle, var(--accent), var(--accent-deep))" : "radial-gradient(circle, var(--accent-deep), var(--accent))"};
      animation-delay: ${i * 2}s;
    `;
    section.style.position = "relative";
    section.insertBefore(blob, section.firstChild);
  });
}

function initScrollReveal() {
  if (!("IntersectionObserver" in window)) {
    document.querySelectorAll(".panel, .stat-card, .search-result-card, .settings-panel, .welcome-hero, .page-intro")
      .forEach((el) => el.classList.add("visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        const children = entry.target.querySelectorAll(".scroll-reveal-3d");
        children.forEach((child, i) => {
          child.style.transitionDelay = `${i * 80}ms`;
        });
      }
    });
  }, { threshold: 0.1, rootMargin: "50px" });

  document.querySelectorAll(".panel, .stat-card, .search-result-card, .settings-panel, .welcome-hero, .page-intro").forEach((el) => {
    if (!el.classList.contains("scroll-reveal-3d")) el.classList.add("scroll-reveal-3d");
    observer.observe(el);
  });
}

function addDepthToCards() {
  document.querySelectorAll(".search-result-card, .activity-item, .saved-item, .stat-card").forEach((card, i) => {
    card.classList.add("depth-shadow");
    card.style.transitionDelay = `${i * 30}ms`;
  });
}

// Initialize on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init3DEffects);
} else {
  init3DEffects();
}

let sidebarInitiallyCollapsed = false;
try {
  sidebarInitiallyCollapsed = window.localStorage.getItem(sidebarPreferenceKey) === "true";
} catch {
  // Le stockage peut être bloqué par le navigateur ou le mode privé.
}
setSidebarCollapsed(sidebarInitiallyCollapsed, false);

/* BUG FIX #2: showView déclarée ICI, puis wrappée APRÈS — plus de hoisting problem */
function showView(name) {
  if (name === "admin" && currentUser?.role !== "admin") name = "overview";

  // Auto-save search criteria before navigating away (amélioration #18)
  const settings = getSettings();
  if (settings.autoSaveSearch) {
    try {
      const form = document.querySelector("#search-form");
      const activeView = document.querySelector(".view.active");
      if (activeView && activeView.id === "view-search" && form) {
        const snapshot = {};
        for (const input of form.querySelectorAll("input[name], select[name]")) {
          if (input.type === "checkbox") { if (input.checked) snapshot[input.name] = true; }
          else if (input.value.trim()) snapshot[input.name] = input.value.trim();
        }
        window.localStorage.setItem("kikzxw.search-autosave", JSON.stringify(snapshot));
      }
    } catch { /* storage unavailable */ }
  }

  for (const view of views) {
    document.querySelector(`#view-${view}`).classList.toggle("active", view === name);
  }
  document.querySelector("#breadcrumb-current").textContent = viewTitles[name];
  document.querySelectorAll(".nav-item").forEach((button) => {
    const isActive = button.dataset.view === name;
    button.classList.toggle("active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  // Restore auto-saved search criteria when entering search view (#18)
  if (name === "search" && settings.autoSaveSearch) {
    try {
      const saved = window.localStorage.getItem("kikzxw.search-autosave");
      if (saved) {
        const snapshot = JSON.parse(saved);
        const form = document.querySelector("#search-form");
        if (form) {
          for (const [key, value] of Object.entries(snapshot)) {
            const field = form.elements.namedItem(key);
            if (!field || !("value" in field)) continue;
            if (field.type === "checkbox") field.checked = Boolean(value);
            else field.value = String(value);
          }
          updateSearchControls();
        }
      }
    } catch { /* ignore */ }
  }

  if (name === "history") renderActivity();
  if (name === "admin") loadAdminPanel();
  if (name === "settings") loadSettings();

  // Refresh card depth after view switch; content remains visible if an observer is unavailable.
  setTimeout(() => {
    addDepthToCards();
  }, 100);
}

/* ---------- Value formatting ---------- */
function formatValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "Oui" : "Non";
  if (Array.isArray(value)) {
    const parts = value.map(formatValue).filter(Boolean);
    return parts.length ? parts.join(", ") : "";
  }
  if (typeof value === "object") {
    const parts = Object.entries(value)
      .map(([key, item]) => {
        const formatted = formatValue(item);
        return formatted ? `${key} : ${formatted}` : "";
      })
      .filter(Boolean);
    return parts.length ? parts.join(" · ") : "";
  }
  const text = String(value).trim();
  if (!text || text === "null" || text === "undefined" || text === "NaN") return "";
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      const parsed = JSON.parse(text);
      const formatted = formatValue(parsed);
      if (formatted) return formatted;
    } catch {
      /* ce n'est pas du JSON : on affiche le texte brut */
    }
  }
  return text;
}

/* ---------- Search field definitions ---------- */
const searchFieldGroups = [
  {
    title: "Identité",
    fields: [
      ["nom_famille", "Nom", "text", {}, "Ex. Martin"],
      ["prenom", "Prénom", "text", {}, "Ex. Marie"],
    ],
  },
  {
    title: "Naissance",
    fields: [
      ["jour_naissance", "Jour (1-31)", "number", { min: 1, max: 31 }, "Ex. 14"],
      ["mois_naissance", "Mois (1-12)", "number", { min: 1, max: 12 }, "Ex. 6"],
      ["annee_naissance", "Année de naissance", "number", { min: 1800, max: 2100 }, "Ex. 1990"],
      ["date_naissance", "Date de naissance", "date"],
      ["ville_naissance", "Ville de naissance", "text", {}, "Ex. Lyon"],
      ["genre", "Genre (m ou f)", "select", { options: [["", "Non précisé"], ["m", "Homme (m)"], ["f", "Femme (f)"]] }],
    ],
  },
  {
    title: "Contact",
    fields: [
      ["email", "E-mail", "email", {}, "Ex. prenom.nom@mail.fr"],
      ["telephone", "Numéro", "tel", {}, "Ex. +33 6 12 34 56 78"],
      ["nom_utilisateur", "Nom d'utilisateur", "text", {}, "Ex. pseudo"],
      ["adresse_ip", "Adresse IP", "text", {}, "Ex. 203.0.113.10"],
    ],
  },
  {
    title: "Localisation",
    fields: [
      ["adresse", "Adresse", "text", {}, "Ex. 12 rue des Lilas"],
      ["code_postal", "Code postal", "text", {}, "Ex. 75011"],
      ["ville", "Ville", "text", {}, "Ex. Paris"],
    ],
  },
  {
    title: "Apps",
    fields: [
      ["steam_id", "Steam ID", "text", {}, "Ex. 76561198000000000"],
      ["fivem_license", "FiveM license", "text", {}, "Ex. license:…"],
      ["discord_id", "Discord ID", "text", {}, "Ex. 123456789012345678"],
      ["xbox_live_id", "Xbox Live (XBL)", "text", {}, "Ex. xuid:…"],
      ["live_id", "Live ID", "text", {}, "Ex. live:…"],
      ["fivem_license2", "FiveM license2", "text", {}, "Ex. license2:…"],
    ],
  },
  {
    title: "Champs avancés",
    fields: [
      ["nir", "NIR (sécu)", "text", {}, "Ex. 1 85 05 78 006 084 32"],
      ["iban", "IBAN", "text", {}, "Ex. FR76 3000 4408 0000 0123 4567 890"],
      ["bic", "BIC", "text", {}, "Ex. BNPAFRPP"],
      ["vin_plaque", "VIN / Plaque", "text", {}, "Ex. VF1AAAAA… ou AB-123-CD"],
    ],
  },
];

const searchFieldOrder = searchFieldGroups.flatMap((group) => group.fields.map(([key]) => key));

const searchLabels = {
  nom_famille: "Nom de famille",
  prenom: "Prénom",
  nom_naissance: "Nom de naissance",
  nom_affichage: "Nom d'affichage",
  nom_utilisateur: "Nom d'utilisateur",
  genre: "Genre",
  civilite: "Civilité",
  date_naissance: "Date de naissance",
  annee_naissance: "Année de naissance",
  jour_naissance: "Jour de naissance",
  mois_naissance: "Mois de naissance",
  email: "E-mail",
  telephone: "Téléphone",
  mobile: "Mobile",
  adresse_ip: "Adresse IP",
  discord_id: "Discord ID",
  adresse: "Adresse",
  complement_adresse: "Complément d'adresse",
  ville: "Ville",
  code_postal: "Code postal",
  departement: "Département",
  region: "Région",
  pays: "Pays",
  ville_naissance: "Ville de naissance",
  lieu_naissance: "Lieu de naissance",
  societe: "Société",
  profession: "Profession",
  fonction: "Fonction",
  siret: "SIRET",
  siren: "SIREN",
  marque: "Marque",
  modele: "Modèle",
  vin_plaque: "VIN / plaque",
  immatriculation: "Immatriculation",
  numero_serie: "Numéro de série",
  iban: "IBAN",
  bic: "BIC",
  nir: "NIR (sécu)",
  steam_id: "Steam ID",
  fivem_license: "FiveM license",
  fivem_license2: "FiveM license 2",
  fivem_id: "FiveM ID",
  xbox_live_id: "Xbox Live ID",
  live_id: "Live ID",
  page: "Page",
  per_page: "Résultats par page",
  flexible: "Recherche approximative",
  status: "Statut HTTP",
  message: "Message",
  timestamp: "Horodatage",
  total: "Total de résultats",
  total_raw: "Total brut",
  total_is_capped: "Total plafonné",
  total_pending: "Total en attente",
  pages: "Nombre de pages",
  query: "Requête",
  took_ms: "Durée totale (ms)",
  count_took_ms: "Durée de comptage (ms)",
  cached: "Réponse en cache",
  maintenance: "Mode maintenance",
  results: "Résultats",
  _all_text: "Texte complet indexé",
  _confidence: "Score de confiance",
  _dedup_key: "Clé de déduplication",
  _es_ids: "Identifiants sources",
  _source_files: "Fichiers sources",
  _sources: "Sources",
};

function searchLabel(key) {
  return searchLabels[key] || key;
}

function renderSearchForm() {
  const container = document.querySelector("#search-fields");
  container.replaceChildren();

  for (const [index, group] of searchFieldGroups.entries()) {
    const section = element("section", "field-group");
    const heading = element("h3", "field-group-heading");
    const head = element("button", "field-group-head");
    head.type = "button";
    head.setAttribute("aria-expanded", "false");
    head.setAttribute("aria-controls", `search-group-content-${index}`);
    head.append(
      element("span", "field-group-title", group.title),
      element("span", "field-group-count", `${group.fields.length} CHAMP${group.fields.length === 1 ? "" : "S"}`),
    );
    heading.append(head);
    section.append(heading);

    const content = element("div", "field-group-content");
    content.id = `search-group-content-${index}`;
    content.setAttribute("aria-hidden", "true");
    content.inert = true;
    const grid = element("div", "field-grid");
    for (const [key, label, type = "text", attrs = {}, placeholder] of group.fields) {
      if (type === "checkbox") {
        const check = element("label", "field-check");
        check.dataset.searchField = "";
        check.dataset.search = `${label} ${key}`.toLocaleLowerCase("fr");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = key;
        check.append(input, element("span", "", label));
        grid.append(check);
        continue;
      }
      const field = element("label", "field");
      field.dataset.searchField = "";
      field.dataset.search = `${label} ${key}`.toLocaleLowerCase("fr");
      field.title = `Champ : ${key}`;
      const headLabel = element("span");
      headLabel.append(document.createTextNode(label.toUpperCase()));
      if (type === "select") {
        const select = document.createElement("select");
        select.name = key;
        select.autocomplete = "off";
        for (const [value, text] of attrs.options || []) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          select.append(option);
        }
        field.append(headLabel, select);
        grid.append(field);
        continue;
      }
      const input = document.createElement("input");
      input.type = type;
      input.name = key;
      input.autocomplete = "off";
      input.spellcheck = false;
      if (placeholder) input.placeholder = placeholder;
      for (const [attribute, value] of Object.entries(attrs)) input.setAttribute(attribute, value);
      field.append(headLabel, input);
      grid.append(field);
    }
    content.append(grid);
    section.append(content);
    container.append(section);
  }

  container.addEventListener("click", (event) => {
    const button = event.target.closest(".field-group-head");
    if (!button || !container.contains(button)) return;
    setSearchGroupOpen(button.closest(".field-group"), button.getAttribute("aria-expanded") !== "true");
  });
}

function setSearchGroupOpen(group, open) {
  const button = group.querySelector(".field-group-head");
  const content = group.querySelector(".field-group-content");
  const isOpen = button.getAttribute("aria-expanded") === "true";
  if (isOpen === open) return;

  group.classList.toggle("is-open", open);
  if (open) {
    for (const sibling of group.parentElement.querySelectorAll(".field-group")) {
      if (sibling !== group) setSearchGroupOpen(sibling, false);
    }
    button.setAttribute("aria-expanded", "true");
    content.setAttribute("aria-hidden", "false");
    content.inert = false;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      content.style.maxHeight = "none";
      return;
    }
    content.style.maxHeight = `${content.scrollHeight}px`;
    content.addEventListener("transitionend", () => {
      if (button.getAttribute("aria-expanded") === "true") content.style.maxHeight = "none";
    }, { once: true });
    return;
  }

  content.style.maxHeight = `${content.scrollHeight}px`;
  button.setAttribute("aria-expanded", "false");
  content.setAttribute("aria-hidden", "true");
  content.inert = true;
  requestAnimationFrame(() => {
    if (button.getAttribute("aria-expanded") === "false") content.style.maxHeight = "0px";
  });
}

function collectSearchPayload() {
  const payload = {};
  let criteria = 0;
  for (const input of document.querySelectorAll("#search-form input[name], #search-form select[name]")) {
    if (input.type === "checkbox") {
      if (input.checked) payload[input.name] = true;
      continue;
    }
    const value = input.value.trim();
    if (!value) continue;
    payload[input.name] = input.type === "number" ? Number(value) : value;
    if (!["page", "per_page", "flexible"].includes(input.name)) criteria += 1;
  }
  return { payload, criteria };
}

function birthDateError(payload) {
  const parts = ["jour_naissance", "mois_naissance", "annee_naissance"];
  const hasPart = parts.some((key) => payload[key] !== undefined);
  if (!hasPart) return "";
  if (payload.date_naissance) {
    return "Renseignez soit la date de naissance, soit le jour, le mois et l'année — pas les deux.";
  }
  if (payload.annee_naissance === undefined) {
    return "L'année de naissance est requise pour préciser le jour ou le mois de naissance.";
  }
  if (payload.jour_naissance !== undefined && payload.mois_naissance === undefined) {
    return "Le mois de naissance est requis pour préciser le jour de naissance.";
  }
  return "";
}

function updateSearchControls() {
  const filter = document.querySelector("#search-field-filter").value.trim().toLocaleLowerCase("fr");
  let criteria = 0;
  const visibleGroups = [];

  for (const group of document.querySelectorAll(".field-group")) {
    let visibleFields = 0;
    for (const field of group.querySelectorAll("[data-search-field]")) {
      const visible = !filter || field.dataset.search.includes(filter);
      field.classList.toggle("hidden", !visible);
      if (visible) visibleFields += 1;
      const input = field.querySelector("input, select");
      if (input?.name && !["page", "per_page", "flexible"].includes(input.name)) {
        if (input.type === "checkbox" ? input.checked : Boolean(input.value.trim())) criteria += 1;
      }
    }
    group.classList.toggle("hidden", visibleFields === 0);
    if (visibleFields > 0) visibleGroups.push(group);
  }

  if (filter && visibleGroups.length) {
    const openGroup = visibleGroups.find((group) => group.querySelector(".field-group-head").getAttribute("aria-expanded") === "true")
      || visibleGroups[0];
    setSearchGroupOpen(openGroup, true);
    for (const group of visibleGroups) {
      if (group !== openGroup) setSearchGroupOpen(group, false);
    }
  }

  const count = document.querySelector("#search-criteria-count");
  count.textContent = `${criteria} critère${criteria === 1 ? "" : "s"} renseigné${criteria === 1 ? "" : "s"}`;
}

function searchQueryTitle(query) {
  const parts = Object.entries(query || {})
    .filter(([key]) => !["page", "per_page", "flexible"].includes(key))
    .slice(0, 3)
    .map(([key, value]) => `${searchLabel(key)} : ${value}`);
  return parts.length ? parts.join(" · ") : "Recherche";
}

function sortSearchEntries(record) {
  const displayPriority = [
    "nom_affichage", "prenom", "nom_famille", "nom_utilisateur", "email",
    "telephone", "mobile", "adresse", "ville", "pays",
  ];
  const order = new Map([...new Set([...displayPriority, ...searchFieldOrder])].map((key, index) => [key, index]));
  const rank = (key) => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  return Object.entries(record).sort(([keyA], [keyB]) => rank(keyA) - rank(keyB));
}

const META_RESULT_KEYS = new Set([
  "page", "per_page", "flexible", "status", "message", "timestamp", "success",
  "total", "total_raw", "total_is_capped", "total_pending", "pages", "query",
  "took_ms", "count_took_ms", "cached", "maintenance", "results", "error", "detail",
]);

function humanizeLabel(key) {
  const known = searchLabels[key];
  if (known) return known;
  return String(key)
    .replace(/^_+/, "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function hasDisplayValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "string") {
    const text = value.trim();
    return Boolean(text) && text !== "null" && text !== "undefined" && text !== "NaN";
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/* ---------- Highlight search terms (#12) ---------- */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const safe = escapeRegex(query);
  const re = new RegExp(`(${safe})`, "gi");
  return escapeHtml(text).replace(re, "<mark class='search-result-highlight'>$1</mark>");
}

function searchResultCard(record, index) {
  const source = isPlainObject(record) ? record : { valeur: record };
  const fields = sortSearchEntries(source)
    .filter(([key, value]) => {
      if (key.startsWith("_")) return false;
      if (META_RESULT_KEYS.has(key)) return false;
      return hasDisplayValue(value);
    });
  const card = element("article", "search-result-card");
  card.style.setProperty("--i", index);
  const heading = element("div", "search-result-card-heading");
  const fieldValue = (key) => {
    const entry = fields.find(([field]) => field === key);
    return entry ? formatValue(entry[1]) : "";
  };
  const displayName = fieldValue("nom_affichage");
  const personalNameFields = ["prenom", "nom_famille"].filter((key) => fieldValue(key));
  const personalName = personalNameFields.map(fieldValue).join(" ");
  const username = fieldValue("nom_utilisateur");
  const email = fieldValue("email");
  const title = displayName || personalName || username || email || `Résultat ${index + 1}`;
  const titleFields = displayName
    ? ["nom_affichage"]
    : personalName
      ? personalNameFields
      : username
        ? ["nom_utilisateur"]
        : email
          ? ["email"]
          : [];
  heading.append(
    element("span", "search-result-number", String(index + 1).padStart(2, "0")),
    element("h4", "search-result-name", title),
  );
  card.append(heading);

  const additionalFields = fields.filter(([key]) => !titleFields.includes(key));
  const primaryFields = additionalFields.slice(0, 8);
  const extraFields = additionalFields.slice(8);

  // Get current result filter query for highlight
  const filterQuery = document.querySelector("#result-filter")?.value.trim().toLocaleLowerCase("fr") || "";

  const renderFields = (container, entries) => {
    for (const [key, value] of entries) {
      const formatted = formatValue(value);
      if (!formatted) continue;
      const row = element("div", "search-result-field");
      // Label: use textContent (safe)
      const labelEl = element("span", "search-result-label");
      labelEl.textContent = humanizeLabel(key);
      // Value: use innerHTML with sanitised highlight
      const valueEl = element("span", "search-result-value");
      if (filterQuery) {
        valueEl.innerHTML = highlightText(formatted, filterQuery);
      } else {
        valueEl.textContent = formatted;
      }
      row.append(labelEl, valueEl);
      container.append(row);
    }
  };

  const fieldGrid = element("div", "search-result-fields");
  renderFields(fieldGrid, primaryFields);
  card.append(fieldGrid);

  if (extraFields.length) {
    const more = element("details", "search-result-more");
    const summary = element("summary", "", `Afficher ${extraFields.length} autre${extraFields.length === 1 ? "" : "s"} champ${extraFields.length === 1 ? "" : "s"}`);
    const extraGrid = element("div", "search-result-fields search-result-extra");
    renderFields(extraGrid, extraFields);
    more.append(summary, extraGrid);
    card.append(more);
  }
  if (!fields.length) {
    card.append(element("p", "search-result-empty", "Aucun champ exploitable dans ce résultat."));
  }
  return card;
}

const knownLocations = new Map([
  ["paris", [48.8566, 2.3522]], ["lyon", [45.764, 4.8357]], ["marseille", [43.2965, 5.3698]],
  ["toulouse", [43.6047, 1.4442]], ["nice", [43.7102, 7.262]], ["nantes", [47.2184, -1.5536]],
  ["strasbourg", [48.5734, 7.7521]], ["montpellier", [43.6108, 3.8767]], ["bordeaux", [44.8378, -0.5792]],
  ["lille", [50.6292, 3.0573]], ["rennes", [48.1173, -1.6778]], ["reims", [49.2583, 4.0317]],
  ["le havre", [49.4944, 0.1079]], ["saint-etienne", [45.4397, 4.3872]], ["toulon", [43.1242, 5.928]],
  ["grenoble", [45.1885, 5.7245]], ["dijon", [47.322, 5.0415]], ["angers", [47.4784, -0.5632]],
  ["nimes", [43.8367, 4.3601]], ["villeurbanne", [45.7719, 4.8902]], ["clermont-ferrand", [45.7772, 3.087]],
  ["limoges", [45.8336, 1.2611]], ["tours", [47.3941, 0.6848]], ["amiens", [49.8941, 2.2958]],
  ["metz", [49.1193, 6.1757]], ["perpignan", [42.6887, 2.8948]], ["besancon", [47.2378, 6.0241]],
  ["orleans", [47.9029, 1.9093]], ["rouen", [49.4432, 1.0993]], ["nancy", [48.6921, 6.1844]],
  ["caen", [49.1829, -0.3707]], ["avignon", [43.9493, 4.8055]], ["versailles", [48.8014, 2.1301]],
  ["poitiers", [46.5802, 0.3404]], ["la rochelle", [46.1603, -1.1511]], ["brest", [48.3904, -4.4861]],
  ["ajaccio", [41.9192, 8.7386]], ["bastia", [42.6973, 9.45]], ["monaco", [43.7384, 7.4246]],
  ["bruxelles", [50.8503, 4.3517]], ["geneve", [46.2044, 6.1432]], ["montreal", [45.5019, -73.5674]],
  ["london", [51.5072, -0.1276]], ["londres", [51.5072, -0.1276]], ["new york", [40.7128, -74.006]],
]);

let worldMapDataPromise;
const WORLD_MAP_DATA_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json";

function loadWorldMapData() {
  if (!worldMapDataPromise) {
    worldMapDataPromise = fetch(WORLD_MAP_DATA_URL, { cache: "force-cache", signal: AbortSignal.timeout(15_000) })
      .then((response) => {
        if (!response.ok) throw new Error(`Carte indisponible (HTTP ${response.status}).`);
        return response.json();
      })
      .then((topology) => {
        if (topology?.type !== "Topology" || !Array.isArray(topology.arcs) || !topology.objects?.countries) {
          throw new Error("Le format des frontières est invalide.");
        }
        return topology;
      })
      .catch((error) => {
        worldMapDataPromise = null;
        throw error;
      });
  }
  return worldMapDataPromise;
}

function coordinateFrom(value) {
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().replace(",", ".");
    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
    value = Number(normalized);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeLocationName(value) {
  return value.toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extractResultLocation(record, index) {
  const sources = [record, ...Object.values(record).filter(isPlainObject)];
  let latitude = null;
  let longitude = null;
  let label = "";
  const normalizedFields = new Map();

  for (const source of sources) {
    for (const [rawKey, value] of Object.entries(source)) {
      const key = normalizeLocationName(rawKey).replace(/[^a-z]/g, "");
      normalizedFields.set(key, value);
      const number = coordinateFrom(value);
      if (number !== null && /^(lat|latitude|geolatitude|coordonneeslatitude|gpslatitude)$/.test(key)) latitude = number;
      if (number !== null && /^(lon|lng|long|longitude|geolongitude|coordonneeslongitude|gpslongitude)$/.test(key)) longitude = number;
    }
  }

  const labelKeys = ["ville", "localite", "adresse", "lieu", "region", "departement", "pays", "codepostal"];
  for (const key of labelKeys) {
    const value = normalizedFields.get(key);
    if (hasDisplayValue(value)) {
      label = formatValue(value);
      break;
    }
  }
  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    latitude = null;
    longitude = null;
  }
  if (latitude === null || longitude === null) {
    const placeText = label || [...normalizedFields.entries()]
      .filter(([key]) => ["ville", "localite", "adresse", "lieu", "region", "departement"].includes(key))
      .map(([, value]) => typeof value === "string" ? value : "")
      .join(" ");
    const normalizedPlace = normalizeLocationName(placeText);
    const match = [...knownLocations.entries()]
      .sort(([nameA], [nameB]) => nameB.length - nameA.length)
      .find(([name]) => new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(normalizedPlace));
    if (match) [latitude, longitude] = match[1];
  }
  if (!label && latitude !== null && longitude !== null) label = `Lieu ${index + 1}`;
  return label || (latitude !== null && longitude !== null)
    ? { label: label || `Lieu ${index + 1}`, latitude, longitude, index }
    : null;
}

let resultMapResizeObserver = null;

function clearResultMap(slot = document.querySelector("#search-result-map")) {
  resultMapResizeObserver?.disconnect();
  resultMapResizeObserver = null;
  slot.replaceChildren();
}

function renderResultMap(results) {
  const slot = document.querySelector("#search-result-map");
  clearResultMap(slot);
  const locations = results
    .map((record, index) => extractResultLocation(isPlainObject(record) ? record : {}, index))
    .filter(Boolean);
  if (!locations.length) return;

  const points = locations.filter(({ latitude, longitude }) => latitude !== null && longitude !== null);
  const map = element("section", "results-map");
  const heading = element("div", "map-heading");
  const headingCopy = element("div");
  headingCopy.append(element("span", "section-kicker", "CARTE DES RÉSULTATS"), element("h3", "", "Répartition géographique"));
  const mapTools = element("div", "map-tools");
  mapTools.append(element("span", "map-count", `${points.length} POINT${points.length === 1 ? "" : "S"}`));
  heading.append(headingCopy, mapTools);
  map.append(heading);

  const mapViewport = element("div", "terrain-map vector-map");
  mapViewport.setAttribute("role", "region");
  mapViewport.setAttribute("aria-label", `Planisphère avec ${points.length} point${points.length === 1 ? "" : "s"} de localisation`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("world-map-svg");
  svg.setAttribute("viewBox", "0 0 1000 500");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Contours vectoriels des pays et localisation des résultats");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const gradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
  gradient.id = "world-map-land";
  gradient.setAttribute("x1", "0");
  gradient.setAttribute("y1", "0");
  gradient.setAttribute("x2", "0.8");
  gradient.setAttribute("y2", "1");
  for (const [offset, color] of [["0%", "#234a34"], ["100%", "#142d20"]]) {
    const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("stop-color", color);
    gradient.append(stop);
  }
  defs.append(gradient);
  svg.append(defs);

  const plot = document.createElementNS("http://www.w3.org/2000/svg", "g");
  plot.classList.add("world-map-plot");
  const countryLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  countryLayer.classList.add("world-country-layer");
  const markerLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  markerLayer.classList.add("world-marker-layer");
  plot.append(countryLayer, markerLayer);
  svg.append(plot);
  mapViewport.append(svg);
  const selectionBox = element("div", "map-selection-box");
  selectionBox.hidden = true;
  selectionBox.setAttribute("aria-hidden", "true");
  mapViewport.append(selectionBox);
  const mapStatus = element("div", "terrain-map-status", "Dessin des frontières des pays…");
  mapStatus.setAttribute("role", "status");
  mapViewport.append(mapStatus);
  map.append(mapViewport);

  const zoomOut = element("button", "map-control", "−");
  zoomOut.type = "button";
  zoomOut.setAttribute("aria-label", "Dézoomer la carte");
  zoomOut.title = "Dézoomer";
  const zoomIn = element("button", "map-control", "+");
  zoomIn.type = "button";
  zoomIn.setAttribute("aria-label", "Zoomer la carte");
  zoomIn.title = "Zoomer";
  const fit = element("button", "map-control map-control-fit", "Cadrer les lieux");
  fit.type = "button";
  fit.setAttribute("aria-label", "Recentrer la carte sur tous les lieux");
  mapTools.append(zoomOut, zoomIn, fit);

  const project = (latitude, longitude) => ({
    x: (longitude + 180) / 360 * 1000,
    y: (90 - latitude) / 180 * 500,
  });
  const addFallbackContinents = () => {
    const silhouettes = [
      "M65 72 101 47 157 42 187 58 210 74 221 98 208 115 193 120 181 145 160 157 147 182 130 187 120 165 104 151 99 125 80 110 72 92Z",
      "M205 183 228 193 246 218 249 247 238 272 233 306 219 336 210 369 198 393 187 378 188 350 178 327 182 299 170 274 177 248 169 224 180 206Z",
      "M420 72 447 58 477 61 490 73 477 88 453 87 438 96 422 89Z",
      "M449 112 481 98 519 105 548 123 574 129 590 151 572 174 550 183 540 207 525 230 513 261 495 283 479 275 469 250 454 229 445 199 430 176 432 145Z",
      "M523 76 560 59 606 53 658 62 690 80 727 76 772 92 809 106 834 128 817 148 786 150 766 171 739 177 716 196 693 185 680 160 657 151 641 128 616 120 595 139 575 126 554 133 533 114Z",
      "M705 188 730 195 742 216 733 236 719 229 708 211Z",
      "M796 302 833 296 859 310 854 331 826 339 805 326Z",
      "M861 358 894 349 922 362 934 388 916 407 884 401 864 383Z",
      "M342 70 371 54 402 60 416 79 402 91 372 87 354 97Z",
    ];
    for (const d of silhouettes) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.classList.add("world-country", "world-continent-fallback");
      countryLayer.append(path);
    }
  };

  const drawCountries = (topology) => {
    const decodedArcs = topology.arcs.map((arc) => {
      let x = 0;
      let y = 0;
      return arc.map(([dx, dy]) => {
        x += dx;
        y += dy;
        return topology.transform
          ? [x * topology.transform.scale[0] + topology.transform.translate[0], y * topology.transform.scale[1] + topology.transform.translate[1]]
          : [x, y];
      });
    });
    const getArc = (index) => index < 0 ? [...decodedArcs[~index]].reverse() : decodedArcs[index];
    const arcPath = (indexes) => {
      const coordinates = [];
      for (const index of indexes) {
        const arc = getArc(index);
        coordinates.push(...(coordinates.length ? arc.slice(1) : arc));
      }
      if (!coordinates.length) return "";
      return `${coordinates.map(([longitude, latitude], index) => {
        const { x, y } = project(latitude, longitude);
        return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
      }).join(" ")} Z`;
    };
    const polygonPath = (polygon) => polygon.map(arcPath).join(" ");
    const geometry = topology.objects.countries.geometries || [];
    for (const country of geometry) {
      const polygons = country.type === "Polygon" ? [country.arcs] : country.arcs;
      const pathData = polygons.map(polygonPath).filter(Boolean).join(" ");
      if (!pathData) continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData);
      path.classList.add("world-country");
      path.setAttribute("fill-rule", "evenodd");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = country.properties?.name || "Pays";
      path.append(title);
      countryLayer.append(path);
    }
  };

  const markerNodes = [];
  for (const point of points) {
    const { x, y } = project(point.latitude, point.longitude);
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "g");
    marker.classList.add("world-marker");
    marker.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    marker.setAttribute("role", "button");
    marker.setAttribute("tabindex", "0");
    marker.setAttribute("aria-label", `${point.index + 1}. ${point.label}, ${point.latitude}, ${point.longitude}`);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${point.label} · ${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`;
    const halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    halo.setAttribute("r", "13");
    halo.classList.add("world-marker-halo");
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("r", "5");
    dot.classList.add("world-marker-dot");
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("y", "-10");
    label.textContent = String(point.index + 1);
    label.classList.add("world-marker-index");
    marker.append(title, halo, dot, label);
    markerLayer.append(marker);
    markerNodes.push({ x, y, point, marker });
  }

  let zoom = 1;
  let translateX = 0;
  let translateY = 0;
  let gesture = null;
  let holdTimer = null;
  const renderTransform = () => {
    plot.setAttribute("transform", `translate(${translateX.toFixed(2)} ${translateY.toFixed(2)}) scale(${zoom.toFixed(3)})`);
    for (const { marker } of markerNodes) {
      marker.querySelector(".world-marker-halo").setAttribute("r", String(13 / zoom));
      marker.querySelector(".world-marker-dot").setAttribute("r", String(5 / zoom));
      marker.querySelector(".world-marker-index").setAttribute("y", String(-10 / zoom));
      marker.querySelector(".world-marker-index").setAttribute("font-size", String(9 / zoom));
    }
  };
  const fitPoints = () => {
    if (!points.length) {
      zoom = 1; translateX = 0; translateY = 0;
      renderTransform();
      return;
    }
    const xs = markerNodes.map(({ x }) => x);
    const ys = markerNodes.map(({ y }) => y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const spanX = Math.max(80, maxX - minX);
    const spanY = Math.max(55, maxY - minY);
    zoom = Math.min(5.5, Math.max(1, Math.min(900 / spanX, 420 / spanY)));
    translateX = 500 - centerX * zoom;
    translateY = 250 - centerY * zoom;
    renderTransform();
  };
  const changeZoom = (factor, focusX = 500, focusY = 250) => {
    const next = Math.max(1, Math.min(8, zoom * factor));
    const scale = next / zoom;
    translateX = focusX - (focusX - translateX) * scale;
    translateY = focusY - (focusY - translateY) * scale;
    zoom = next;
    renderTransform();
  };
  const screenToMap = (clientX, clientY) => {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const matrix = svg.getScreenCTM();
    if (matrix) {
      const result = point.matrixTransform(matrix.inverse());
      return { x: (result.x - translateX) / zoom, y: (result.y - translateY) / zoom };
    }
    const bounds = mapViewport.getBoundingClientRect();
    return {
      x: ((clientX - bounds.left) / bounds.width * 1000 - translateX) / zoom,
      y: ((clientY - bounds.top) / bounds.height * 500 - translateY) / zoom,
    };
  };
  const updateSelectionBox = (clientX, clientY) => {
    const bounds = mapViewport.getBoundingClientRect();
    const left = Math.min(gesture.startClientX, clientX) - bounds.left;
    const top = Math.min(gesture.startClientY, clientY) - bounds.top;
    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${Math.abs(clientX - gesture.startClientX)}px`;
    selectionBox.style.height = `${Math.abs(clientY - gesture.startClientY)}px`;
  };
  const zoomToMarker = ({ x, y }) => changeZoom(1.7, translateX + zoom * x, translateY + zoom * y);
  for (const entry of markerNodes) {
    entry.marker.addEventListener("click", () => zoomToMarker(entry));
    entry.marker.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      zoomToMarker(entry);
    });
  }
  zoomOut.addEventListener("click", () => changeZoom(1 / 1.35));
  zoomIn.addEventListener("click", () => changeZoom(1.35));
  fit.addEventListener("click", fitPoints);
  mapViewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".world-marker, .map-control")) return;
    const startMap = screenToMap(event.clientX, event.clientY);
    gesture = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startMap,
      startTranslateX: translateX,
      startTranslateY: translateY,
      mode: "pending",
    };
    mapViewport.setPointerCapture(event.pointerId);
    holdTimer = window.setTimeout(() => {
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.mode !== "pending") return;
      gesture.mode = "select";
      mapViewport.classList.add("is-selecting");
      mapStatus.textContent = "Zone activée — faites glisser pour cadrer la carte.";
      mapStatus.hidden = false;
    }, 2000);
  });
  mapViewport.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (gesture.mode === "pending" && Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) > 7) {
      gesture.mode = "pan";
      window.clearTimeout(holdTimer);
      mapViewport.classList.add("is-dragging");
    }
    if (gesture.mode === "pending") return;
    if (gesture.mode === "select") {
      updateSelectionBox(event.clientX, event.clientY);
      return;
    }
    const bounds = mapViewport.getBoundingClientRect();
    translateX = gesture.startTranslateX + (event.clientX - gesture.startClientX) * 1000 / bounds.width;
    translateY = gesture.startTranslateY + (event.clientY - gesture.startClientY) * 500 / bounds.height;
    renderTransform();
  });
  const finishDrag = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    window.clearTimeout(holdTimer);
    if (gesture.mode === "select") {
      const endMap = screenToMap(event.clientX, event.clientY);
      const spanX = Math.abs(endMap.x - gesture.startMap.x);
      const spanY = Math.abs(endMap.y - gesture.startMap.y);
      if (spanX > 12 && spanY > 12) {
        const nextZoom = Math.min(8, Math.min(1000 / spanX, 500 / spanY) * 0.9);
        const centerX = (endMap.x + gesture.startMap.x) / 2;
        const centerY = (endMap.y + gesture.startMap.y) / 2;
        zoom = Math.max(zoom, nextZoom);
        translateX = 500 - centerX * zoom;
        translateY = 250 - centerY * zoom;
        renderTransform();
      }
    }
    gesture = null;
    selectionBox.hidden = true;
    mapStatus.hidden = true;
    mapViewport.classList.remove("is-dragging");
    mapViewport.classList.remove("is-selecting");
  };
  mapViewport.addEventListener("pointerup", finishDrag);
  mapViewport.addEventListener("pointercancel", finishDrag);
  mapViewport.addEventListener("contextmenu", (event) => event.preventDefault());
  mapViewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  if (points.length) fitPoints();
  if ("ResizeObserver" in window) {
    resultMapResizeObserver = new ResizeObserver(() => renderTransform());
    resultMapResizeObserver.observe(mapViewport);
  }
  loadWorldMapData().then((topology) => {
    if (!mapViewport.isConnected) return;
    countryLayer.replaceChildren();
    drawCountries(topology);
    mapStatus.hidden = true;
  }).catch(() => {
    if (!mapViewport.isConnected) return;
    countryLayer.replaceChildren();
    addFallbackContinents();
    mapStatus.textContent = "Contours des pays indisponibles — affichage simplifié.";
    mapStatus.hidden = false;
  });

  const placeList = element("ul", "map-place-list");
  for (const [index, location] of locations.slice(0, 8).entries()) {
    const item = element("li", "map-place");
    item.append(element("span", "map-place-index", String(index + 1).padStart(2, "0")), element("span", "map-place-name", location.label));
    if (location.latitude !== null && location.longitude !== null) {
      item.append(element("span", "map-place-coordinates", `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`));
    }
    placeList.append(item);
  }
  if (locations.length > 8) placeList.append(element("li", "map-place-overflow", `+ ${locations.length - 8} autres lieux dans les résultats`));
  map.append(placeList);
  map.append(element("p", "map-caption", "Les marqueurs utilisent les coordonnées des résultats ou celles des villes reconnues localement. Les contours vectoriels sont chargés une fois depuis World Atlas / Natural Earth ; aucune adresse n'est envoyée pour géocodage."));
  slot.append(map);
}

function renderSearchPager(page, pages) {
  const pager = document.querySelector("#search-pager");
  pager.replaceChildren();
  const previous = element("button", "pager-button", `← Page ${page - 1}`);
  previous.type = "button";
  previous.disabled = page <= 1;
  previous.addEventListener("click", () => runSearch({ ...activeSearch, page: page - 1 }, document.querySelector("#search-submit")));
  const counter = element("span", "pager-counter", `PAGE ${page} / ${pages}`);
  const next = element("button", "pager-button", `Page ${page + 1} →`);
  next.type = "button";
  next.disabled = page >= pages;
  next.addEventListener("click", () => runSearch({ ...activeSearch, page: page + 1 }, document.querySelector("#search-submit")));
  pager.append(previous, counter, next);
  pager.classList.remove("hidden");
}

function hideSearchPager() {
  document.querySelector("#search-pager").classList.add("hidden");
}

/* Amélioration #12: applyResultFilter avec highlight */
function applyResultFilter() {
  const filter = document.querySelector("#result-filter");
  const query = filter.value.trim().toLocaleLowerCase("fr");
  const cards = [...document.querySelectorAll(".search-result-card")];
  let visible = 0;
  for (const card of cards) {
    const matches = !query || card.textContent.toLocaleLowerCase("fr").includes(query);
    card.classList.toggle("hidden", !matches);
    if (matches) {
      visible += 1;
      // Update highlights on visible value spans
      for (const valueEl of card.querySelectorAll(".search-result-value")) {
        const raw = valueEl.textContent;
        if (query) {
          valueEl.innerHTML = highlightText(raw, query);
        } else {
          // Remove marks, restore plain text
          valueEl.textContent = valueEl.textContent;
        }
      }
    }
  }
  const count = document.querySelector(".search-results-count");
  if (count) count.textContent = `${visible} AFFICHÉ${visible === 1 ? "" : "S"}`;
}
