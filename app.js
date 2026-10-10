const views = ["overview", "search", "history", "admin"];
const sidebarToggle = document.querySelector("#sidebar-toggle");
const sidebarPreferenceKey = "kikzxw.sidebar-collapsed";
const viewTitles = {
  overview: "Tableau de bord",
  search: "Recherche",
  history: "Historique",
  admin: "Administration",
};
const activity = [];
let activeSearch = null;
let currentUser = null;
let currentResults = null;
let savedSearches = [];
let authMode = "login";

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

let sidebarInitiallyCollapsed = false;
try {
  sidebarInitiallyCollapsed = window.localStorage.getItem(sidebarPreferenceKey) === "true";
} catch {
  // Le stockage peut être bloqué par le navigateur ou le mode privé.
}
setSidebarCollapsed(sidebarInitiallyCollapsed, false);

function showView(name) {
  if (name === "admin" && currentUser?.role !== "admin") name = "overview";
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
  if (name === "history") renderActivity();
  if (name === "admin") loadAdminPanel();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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
  const renderFields = (container, entries) => {
    for (const [key, value] of entries) {
      const formatted = formatValue(value);
      if (!formatted) continue;
      const row = element("div", "search-result-field");
      row.append(
        element("span", "search-result-label", humanizeLabel(key)),
        element("span", "search-result-value", formatted),
      );
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
      zoom = 1;
      translateX = 0;
      translateY = 0;
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

function applyResultFilter() {
  const filter = document.querySelector("#result-filter");
  const query = filter.value.trim().toLocaleLowerCase("fr");
  const cards = [...document.querySelectorAll(".search-result-card")];
  let visible = 0;
  for (const card of cards) {
    const matches = !query || card.textContent.toLocaleLowerCase("fr").includes(query);
    card.classList.toggle("hidden", !matches);
    if (matches) visible += 1;
  }
  const count = document.querySelector(".search-results-count");
  if (count) count.textContent = `${visible} AFFICHÉ${visible === 1 ? "" : "S"}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function searchErrorMessage(payload, statusCode) {
  const candidates = [payload?.error, payload?.message, payload?.detail];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (isPlainObject(candidate) && typeof candidate.message === "string" && candidate.message.trim()) {
      return candidate.message.trim();
    }
  }
  return `La recherche a échoué (HTTP ${statusCode}).`;
}

function safeResponseNumber(value, minimum) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function normalizeSearchResponse(payload, statusCode, search) {
  if (!isPlainObject(payload)) {
    return { error: "Le service de recherche a renvoyé une réponse JSON inattendue." };
  }

  const apiStatus = payload.status;
  const apiFailed = payload.success === false
    || apiStatus === "error"
    || (typeof apiStatus === "number" && apiStatus >= 400)
    || Boolean(payload.error);
  if (statusCode < 200 || statusCode >= 300 || apiFailed) {
    return { error: searchErrorMessage(payload, statusCode) };
  }

  const data = isPlainObject(payload.data) ? payload.data : {};
  const rawResults = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(data.results)
      ? data.results
      : Array.isArray(payload.data)
        ? payload.data
        : null;
  if (!rawResults) {
    return { error: "Le service de recherche a renvoyé un JSON valide, mais sans liste de résultats exploitable." };
  }

  const usable = rawResults.map((entry) => {
    if (isPlainObject(entry)) return { entry, valid: true };
    if (entry !== undefined && entry !== null && typeof entry !== "function") {
      return { entry: { valeur: entry }, valid: typeof entry !== "object" };
    }
    return { entry: null, valid: false };
  });
  const results = usable.map((item) => item.entry).filter(Boolean);
  const invalidResults = usable.filter((item) => !item.entry).length;

  const meta = isPlainObject(payload.meta)
    ? payload.meta
    : isPlainObject(payload.data) && isPlainObject(payload.data.meta)
      ? payload.data.meta
      : {};
  const readNumber = (...values) => {
    for (const value of values) {
      const number = safeResponseNumber(value, 0);
      if (number !== null) return number;
    }
    return null;
  };
  const pages = readNumber(meta.pages, payload.pages) || 1;
  const requestedPage = readNumber(meta.page, payload.page, search.page) || 1;
  const page = Math.min(Math.max(requestedPage, 1), pages);
  const total = readNumber(meta.total, payload.total, data.total) ?? rawResults.length;
  const metaQuery = isPlainObject(meta.query) ? meta.query : isPlainObject(payload.query) ? payload.query : null;
  return {
    data: { results },
    invalidResults,
    meta: {
      page,
      pages,
      total: Math.max(total, results.length),
      query: metaQuery || search,
    },
  };
}

function renderSearchResult(payload, statusCode = 200, search = {}) {
  const panel = document.querySelector("#search-result-panel");
  const statusBadge = document.querySelector("#search-result-status");
  const toolbar = document.querySelector("#result-toolbar");
  const normalized = normalizeSearchResponse(payload, statusCode, search);
  const ok = !normalized.error;
  panel.classList.remove("hidden");
  statusBadge.className = `result-status ${ok ? "success" : "error"}`;
  statusBadge.textContent = ok ? "TERMINÉ" : "ERREUR";
  document.querySelector("#search-result-title").textContent = searchQueryTitle(normalized.meta?.query || search);

  const summary = document.querySelector("#search-result-summary");
  const sections = document.querySelector("#search-result-sections");
  const mapSlot = document.querySelector("#search-result-map");
  summary.replaceChildren();
  sections.replaceChildren();
  clearResultMap(mapSlot);

  if (!ok) {
    currentResults = null;
    toolbar.classList.add("hidden");
    summary.append(element("div", "result-error", normalized.error));
    hideSearchPager();
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const { data, meta, invalidResults } = normalized;
  const { results } = data;
  const { total, page, pages } = meta;
  currentResults = { results, meta: { ...meta, query: normalized.meta.query }, invalidResults };
  renderResultMap(results);

  const chips = [
    `${total} RÉSULTAT${total === 1 ? "" : "S"}`,
    `PAGE ${page} / ${pages}`,
  ];
  for (const text of chips) summary.append(element("div", "summary-chip", text));
  if (pages > 1) renderSearchPager(page, pages);
  else hideSearchPager();

  const resultsSection = element("section", "result-section search-results");
  const resultsHeading = element("div", "search-results-heading");
  resultsHeading.append(
    element("h3", "result-section-title", "Résultats"),
    element("span", "search-results-count", `${results.length} AFFICHÉ${results.length === 1 ? "" : "S"}`),
  );
  resultsSection.append(resultsHeading);

  if (!results.length) {
    resultsSection.append(element(
      "p",
      "search-result-empty",
      invalidResults
        ? "La réponse ne contenait aucun résultat exploitable."
        : "Aucun résultat pour ces critères.",
    ));
  } else {
    const resultList = element("div", "search-result-list");
    for (const [index, record] of results.slice(0, 50).entries()) {
      resultList.append(searchResultCard(record, index));
    }
    resultsSection.append(resultList);
    if (invalidResults) {
      resultsSection.append(element("div", "result-note", `${invalidResults} entrée(s) ignorée(s), car leur format JSON était inattendu.`));
    }
    if (results.length > 50) {
      resultsSection.append(element("div", "result-note", `${results.length - 50} résultat(s) supplémentaires non affichés — utilisez la pagination à côté du bouton de recherche.`));
    }
  }
  sections.append(resultsSection);

  toolbar.classList.remove("hidden");
  const filterInput = document.querySelector("#result-filter");
  if (filterInput.value) filterInput.value = "";
  applyResultFilter();

  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function readJsonResponse(response, serviceName) {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`${serviceName} a renvoyé une réponse vide (HTTP ${response.status}).`);
  }
  try {
    const payload = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!isPlainObject(payload)) throw new Error("JSON object expected");
    return payload;
  } catch {
    throw new Error(`${serviceName} a renvoyé une réponse JSON invalide ou inattendue (HTTP ${response.status}).`);
  }
}

async function runSearch(payload, button) {
  const criteriaPayload = { ...payload };
  delete criteriaPayload.page;
  activeSearch = criteriaPayload;
  hideSearchPager();
  button.disabled = true;
  const buttonLabel = button.querySelector(".button-label");
  const initialText = buttonLabel?.textContent;
  if (buttonLabel) buttonLabel.textContent = "Recherche en cours…";
  document.querySelector("#search-form-error").classList.add("hidden");
  const panel = document.querySelector("#search-result-panel");
  panel.classList.remove("hidden");
  document.querySelector("#search-result-title").textContent = searchQueryTitle(payload);
  document.querySelector("#search-result-status").className = "result-status";
  document.querySelector("#search-result-status").textContent = "EN COURS";
  document.querySelector("#search-result-summary").replaceChildren(element("div", "result-note", "Recherche en cours…"));
  clearResultMap();
  document.querySelector("#search-result-sections").replaceChildren();

  let statusCode = 502;
  let data = {};
  try {
    const response = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    statusCode = response.status;
    data = await readJsonResponse(response, "Le service de recherche");
    if (response.status === 401) {
      applySession(null);
      showToast("Session expirée : reconnectez-vous.", "error");
    }
  } catch (error) {
    data = { error: error.message || "Impossible de joindre le serveur." };
  } finally {
    button.disabled = false;
    if (buttonLabel) buttonLabel.textContent = initialText;
  }

  const criteria = Object.keys(payload).filter((key) => !["page", "per_page", "flexible"].includes(key)).length;
  activity.push({
    target: searchQueryTitle(payload),
    searchPayload: { ...payload },
    responsePayload: data,
    statusCode,
    timestamp: Date.now(),
    time: new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date()),
    ok: statusCode >= 200 && statusCode < 300 && !data?.error,
    detail: `${criteria} CRITÈRE${criteria === 1 ? "" : "S"} · RECHERCHE`,
  });
  renderActivity();
  renderSearchResult(data, statusCode, payload);
}

function renderActivityList(container, emptyMessage) {
  container.replaceChildren();
  if (activity.length === 0) {
    const empty = element("div", "empty-state");
    empty.append(
      element("span", "empty-symbol", "◷"),
      element("strong", "", emptyMessage),
      element("p", "", "Lancez une recherche pour voir son activité ici."),
    );
    container.append(empty);
    return;
  }

  for (const item of [...activity].reverse().slice(0, 20)) {
    const row = element("article", "activity-item");
    const icon = element("span", "activity-icon", "⌕");
    const main = element("div", "activity-main");
    const savedDate = new Date(item.timestamp);
    const formattedTime = Number.isNaN(savedDate.getTime())
      ? item.time || "Heure inconnue"
      : new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(savedDate);
    main.append(
      element("div", "activity-title", item.target),
      element("div", "activity-meta", `${formattedTime} · ${item.detail || "Recherche multicritère"}`),
    );
    const action = element("button", "activity-open", item.ok ? "Ouvrir" : "Reprendre");
    action.type = "button";
    action.setAttribute("aria-label", `${item.ok ? "Ouvrir" : "Reprendre"} la recherche : ${item.target}`);
    action.disabled = !item.searchPayload;
    action.addEventListener("click", () => restoreActivitySearch(item));
    row.append(icon, main, element("span", `activity-badge ${item.ok ? "" : "error"}`, item.ok ? "TERMINÉ" : "ERREUR"), action);
    container.append(row);
  }
}

function restoreActivitySearch(item) {
  if (!item.searchPayload) {
    showToast("Les critères de cette entrée ne sont plus disponibles.", "error");
    return;
  }
  const form = document.querySelector("#search-form");
  form.reset();
  document.querySelector("#search-field-filter").value = "";
  for (const [key, value] of Object.entries(item.searchPayload)) {
    const field = form.elements.namedItem(key);
    if (!field || !("value" in field)) continue;
    field.value = String(value);
  }
  updateSearchControls();
  showView("search");
  if (item.responsePayload && Number.isInteger(item.statusCode)) {
    renderSearchResult(item.responsePayload, item.statusCode, item.searchPayload);
    showToast("Résultats de cette recherche restaurés depuis l'historique.");
  } else {
    showToast("Critères restaurés. Relancez la recherche pour obtenir les résultats.", "info");
  }
}

function renderSearchChart() {
  const container = document.querySelector("#search-chart");
  const totalLabel = document.querySelector("#search-chart-total");
  if (!container || !totalLabel) return;

  const now = new Date();
  const currentHour = new Date(now);
  currentHour.setMinutes(0, 0, 0);
  const buckets = Array.from({ length: 12 }, (_, index) => {
    const start = new Date(currentHour);
    start.setHours(currentHour.getHours() - (11 - index));
    return { start, count: 0 };
  });

  for (const item of activity) {
    const timestamp = Number(item.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const hour = new Date(timestamp);
    hour.setMinutes(0, 0, 0);
    const bucket = buckets.find(({ start }) => start.getTime() === hour.getTime());
    if (bucket) bucket.count += 1;
  }

  const count = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const width = 720;
  const height = 210;
  const plot = { left: 48, top: 16, right: 704, bottom: 163 };
  const plotHeight = plot.bottom - plot.top;
  const plotWidth = plot.right - plot.left;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-hidden", "true");

  const makeSvg = (tag, attributes, parent = svg) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    parent.append(node);
    return node;
  };

  const defs = makeSvg("defs", {});
  const gradient = makeSvg("linearGradient", { id: "search-chart-fill", x1: "0", y1: "0", x2: "0", y2: "1" }, defs);
  makeSvg("stop", { offset: "0", "stop-color": "#54d18a", "stop-opacity": ".35" }, gradient);
  makeSvg("stop", { offset: "1", "stop-color": "#54d18a", "stop-opacity": "0" }, gradient);

  const tickCount = Math.min(3, maximum);
  for (let tick = 0; tick <= tickCount; tick += 1) {
    const value = Math.round(maximum * tick / tickCount);
    const y = plot.bottom - value / maximum * plotHeight;
    makeSvg("line", { x1: plot.left, x2: plot.right, y1: y, y2: y, class: "search-chart-grid" });
    const label = makeSvg("text", { x: plot.left - 10, y: y + 4, "text-anchor": "end", class: "search-chart-axis" });
    label.textContent = String(value);
  }

  const step = plotWidth / (buckets.length - 1);
  const points = buckets.map((bucket, index) => ({
    x: plot.left + step * index,
    y: plot.bottom - bucket.count / maximum * plotHeight,
    bucket,
    index,
  }));

  const toCurve = (pts) => {
    if (pts.length < 2) return "";
    const tension = 0.8;
    let path = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const cp1x = p1.x + ((p2.x - p0.x) / 6) * tension;
      const cp1y = p1.y + ((p2.y - p0.y) / 6) * tension;
      const cp2x = p2.x - ((p3.x - p1.x) / 6) * tension;
      const cp2y = p2.y - ((p3.y - p1.y) / 6) * tension;
      path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return path;
  };

  const linePath = toCurve(points);
  makeSvg("path", {
    d: `${linePath} L ${plot.right} ${plot.bottom} L ${plot.left} ${plot.bottom} Z`,
    class: "search-chart-area",
    fill: "url(#search-chart-fill)",
  });
  makeSvg("path", { d: linePath, class: "search-chart-line", pathLength: "1" });

  for (const point of points) {
    const isCurrent = point.index === points.length - 1;
    const dot = makeSvg("circle", {
      cx: point.x,
      cy: point.y,
      r: isCurrent ? 4.5 : 3.2,
      class: `search-chart-dot${isCurrent ? " current" : ""}${point.bucket.count ? " has-value" : ""}`,
    });
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${new Intl.DateTimeFormat("fr-FR", { hour: "2-digit" }).format(point.bucket.start)} · ${point.bucket.count} recherche${point.bucket.count === 1 ? "" : "s"}`;
    dot.append(title);
  }

  buckets.forEach((bucket, index) => {
    if (index % 3 !== 0 && index !== buckets.length - 1) return;
    const label = makeSvg("text", {
      x: plot.left + step * index,
      y: plot.bottom + 23,
      "text-anchor": "middle",
      class: "search-chart-axis search-chart-time",
    });
    label.textContent = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit" }).format(bucket.start);
  });

  if (count === 0) {
    const empty = makeSvg("text", { x: width / 2, y: 93, "text-anchor": "middle", class: "search-chart-empty" });
    empty.textContent = "Lancez une recherche pour voir votre activité";
  }

  container.replaceChildren(svg);
  container.setAttribute(
    "aria-label",
    count
      ? `${count} recherche${count === 1 ? "" : "s"} effectuée${count === 1 ? "" : "s"} au cours des douze dernières heures.`
      : "Aucune recherche effectuée au cours des douze dernières heures.",
  );
  totalLabel.textContent = `${count} RECHERCHE${count === 1 ? "" : "S"} · 12 H`;
}

function renderActivity() {
  document.querySelector("#stat-searches").textContent = String(activity.length).padStart(2, "0");
  renderSearchChart();
  document.querySelector("#history-count").textContent = `${String(activity.length).padStart(2, "0")} ENTRÉE${activity.length === 1 ? "" : "S"}`;
  renderActivityList(document.querySelector("#history-list"), "Votre historique est vide");
  renderActivityList(document.querySelector("#overview-activity"), "Aucune recherche pour le moment");
}

/* ---------- Toasts ---------- */
function showToast(message, kind = "info") {
  let host = document.querySelector("#toast-host");
  if (!host) {
    host = element("div", "toast-host");
    host.id = "toast-host";
    document.body.append(host);
  }
  const toast = element("div", `toast toast-${kind}`, message);
  host.append(toast);
  window.setTimeout(() => {
    toast.classList.add("toast-out");
    window.setTimeout(() => toast.remove(), 300);
  }, 3200);
}

/* ---------- Session / authentification ---------- */
async function apiRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, ok: response.ok, payload };
}

function applySession(user) {
  currentUser = user;
  const chip = document.querySelector("#user-chip");
  const overlay = document.querySelector("#auth-overlay");
  const navAdmin = document.querySelector("#nav-admin");
  if (user) {
    chip.classList.remove("hidden");
    document.querySelector("#logout-button").classList.remove("hidden");
    document.querySelector("#user-name").textContent = user.username;
    document.querySelector("#user-role").textContent = user.role === "admin" ? "ADMINISTRATEUR" : "MEMBRE";
    document.querySelector("#user-role").classList.toggle("admin", user.role === "admin");
    document.querySelector("#user-avatar").textContent = user.username.slice(0, 2).toUpperCase();
    overlay.classList.add("hidden");
    navAdmin.classList.toggle("hidden", user.role !== "admin");
  } else {
    chip.classList.add("hidden");
    document.querySelector("#logout-button").classList.add("hidden");
    overlay.classList.remove("hidden");
    navAdmin.classList.add("hidden");
    if (document.querySelector("#view-admin").classList.contains("active")) showView("overview");
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const loginTab = document.querySelector("#auth-tab-login");
  const registerTab = document.querySelector("#auth-tab-register");
  loginTab.classList.toggle("active", mode === "login");
  registerTab.classList.toggle("active", mode === "register");
  loginTab.setAttribute("aria-selected", mode === "login");
  registerTab.setAttribute("aria-selected", mode === "register");
  loginTab.tabIndex = mode === "login" ? 0 : -1;
  registerTab.tabIndex = mode === "register" ? 0 : -1;
  document.querySelector("#auth-form").setAttribute("aria-labelledby", mode === "login" ? loginTab.id : registerTab.id);
  document.querySelector("#auth-submit .button-label").textContent = mode === "login" ? "Se connecter" : "Créer le compte";
  document.querySelector("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  document.querySelector("#auth-error").classList.add("hidden");
}

async function refreshSession() {
  try {
    const { ok, payload } = await apiRequest("/api/auth/me");
    if (!ok && payload?.error && !/session inactive|expirée/i.test(payload.error)) {
      throw new Error(payload.error);
    }
    applySession(ok ? payload.user : null);
  } catch (error) {
    applySession(null);
    showToast(error.message || "Impossible de vérifier la session.", "error");
  }
}

async function loadAdminPanel() {
  if (currentUser?.role !== "admin") return;
  try {
    const [statsResponse, usersResponse] = await Promise.all([
      apiRequest("/api/admin/stats"),
      apiRequest("/api/admin/users"),
    ]);
    if (!statsResponse.ok || !usersResponse.ok) {
      const error = statsResponse.payload?.error || usersResponse.payload?.error || "Chargement de l'administration impossible.";
      if (statsResponse.status === 401 || usersResponse.status === 401) applySession(null);
      throw new Error(error);
    }
    document.querySelector("#admin-stat-users").textContent = String(statsResponse.payload.users ?? 0).padStart(2, "0");
    document.querySelector("#admin-stat-searches").textContent = String(statsResponse.payload.searches ?? 0).padStart(2, "0");
    document.querySelector("#admin-stat-saved").textContent = String(statsResponse.payload.savedSearches ?? 0).padStart(2, "0");

    const body = document.querySelector("#admin-users-body");
    const users = Array.isArray(usersResponse.payload.users) ? usersResponse.payload.users : [];
    body.replaceChildren();
    document.querySelector("#admin-empty").classList.toggle("hidden", users.length > 0);
    document.querySelector(".admin-table-wrap").classList.toggle("hidden", users.length === 0);
    for (const user of users) {
      const row = element("tr");
      const username = element("td", "admin-username", user.username);
      const id = element("td", "admin-user-id", user.id);
      const roleCell = element("td");
      const role = element("select", "admin-role");
      role.setAttribute("aria-label", `Rôle de ${user.username}`);
      for (const [value, label] of [["admin", "Administrateur"], ["membre", "Membre"]]) {
        const option = element("option", "", label);
        option.value = value;
        role.append(option);
      }
      role.value = user.role;
      role.disabled = user.id === currentUser.id;
      role.addEventListener("change", async () => {
        try {
          const response = await apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}`, {
            method: "PATCH",
            body: { role: role.value },
          });
          if (!response.ok) throw new Error(response.payload?.error || "Modification du rôle impossible.");
          showToast(`Rôle de ${user.username} mis à jour.`);
          await loadAdminPanel();
        } catch (error) {
          showToast(error.message || "Modification du rôle impossible.", "error");
          role.value = user.role;
        }
      });
      roleCell.append(role);
      const searchCount = element("td", "", String(user.searchCount ?? 0));
      const created = new Date(user.createdAt);
      const createdAt = element("td", "", Number.isNaN(created.getTime())
        ? "—"
        : new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(created));
      const actions = element("td");
      const remove = element("button", "text-button admin-delete", "Supprimer");
      remove.type = "button";
      remove.disabled = user.id === currentUser.id;
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Supprimer définitivement le compte « ${user.username} » ?`)) return;
        try {
          const response = await apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
          if (!response.ok) throw new Error(response.payload?.error || "Suppression du compte impossible.");
          showToast(`Compte ${user.username} supprimé.`);
          await loadAdminPanel();
        } catch (error) {
          showToast(error.message || "Suppression du compte impossible.", "error");
        }
      });
      actions.append(remove);
      row.append(username, id, roleCell, searchCount, createdAt, actions);
      body.append(row);
    }
  } catch (error) {
    showToast(error.message || "Chargement de l'administration impossible.", "error");
  }
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});
document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.go));
});
sidebarToggle.addEventListener("click", () => {
  setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
});

document.querySelector("#auth-tab-login").addEventListener("click", () => setAuthMode("login"));
document.querySelector("#auth-tab-register").addEventListener("click", () => setAuthMode("register"));
document.querySelector(".auth-tabs").addEventListener("keydown", (event) => {
  const nextMode = event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "End"
    ? "register"
    : event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home"
      ? "login"
      : null;
  if (!nextMode) return;
  event.preventDefault();
  setAuthMode(nextMode);
  document.querySelector(nextMode === "login" ? "#auth-tab-login" : "#auth-tab-register").focus();
});
document.querySelector("#auth-reveal").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const password = document.querySelector("#auth-password");
  const reveal = password.type === "password";
  password.type = reveal ? "text" : "password";
  button.setAttribute("aria-label", reveal ? "Masquer le mot de passe" : "Afficher le mot de passe");
  button.textContent = reveal ? "●" : "○";
});
document.querySelector("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = document.querySelector("#auth-submit");
  const label = submit.querySelector(".button-label");
  const errorBox = document.querySelector("#auth-error");
  const username = document.querySelector("#auth-username").value.trim();
  const password = document.querySelector("#auth-password").value;
  submit.disabled = true;
  errorBox.classList.add("hidden");
  label.textContent = authMode === "login" ? "Connexion…" : "Création…";
  try {
    const response = await apiRequest(`/api/auth/${authMode === "login" ? "login" : "register"}`, {
      method: "POST",
      body: { username, password },
    });
    if (!response.ok || !response.payload?.user) {
      throw new Error(response.payload?.error || "Le serveur a refusé la demande d'authentification.");
    }
    applySession(response.payload.user);
    form.reset();
    showToast(authMode === "login" ? "Connexion réussie." : "Compte créé, bienvenue sur KIKZXW.");
    if (response.payload.firstUser) showToast("Premier compte créé : rôle administrateur.");
  } catch (error) {
    errorBox.textContent = error.message || "Impossible de joindre le serveur d'authentification.";
    errorBox.classList.remove("hidden");
  } finally {
    submit.disabled = false;
    label.textContent = authMode === "login" ? "Se connecter" : "Créer le compte";
  }
});
document.querySelector("#logout-button").addEventListener("click", async () => {
  const button = document.querySelector("#logout-button");
  button.disabled = true;
  try {
    const response = await apiRequest("/api/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error(response.payload?.error || "La déconnexion a échoué.");
    applySession(null);
    setAuthMode("login");
    showToast("Vous êtes déconnecté.");
  } catch (error) {
    showToast(error.message || "Impossible de fermer la session.", "error");
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#admin-refresh").addEventListener("click", loadAdminPanel);
document.querySelector("#result-filter").addEventListener("input", applyResultFilter);
refreshSession();

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const { payload, criteria } = collectSearchPayload();
  const errorBox = document.querySelector("#search-form-error");
  if (!criteria) {
    errorBox.textContent = "Renseignez au moins un critère de recherche (l'option flexible ne compte pas comme critère).";
    errorBox.classList.remove("hidden");
    return;
  }
  const birthError = birthDateError(payload);
  if (birthError) {
    errorBox.textContent = birthError;
    errorBox.classList.remove("hidden");
    return;
  }
  errorBox.classList.add("hidden");
  runSearch(payload, document.querySelector("#search-submit"));
});

renderSearchForm();
document.querySelector("#search-field-filter").addEventListener("input", updateSearchControls);
document.querySelector("#search-fields").addEventListener("input", updateSearchControls);
document.querySelector("#search-fields").addEventListener("change", updateSearchControls);
document.querySelector("#search-form").addEventListener("reset", () => {
  window.setTimeout(updateSearchControls, 0);
});
updateSearchControls();
renderActivity();

const clockTime = document.querySelector("#peaclock-time");
const clockDate = document.querySelector("#peaclock-date");
const clockFormatButton = document.querySelector("#peaclock-format");
let clock24Hour = true;
const updatePeaclock = () => {
  const now = new Date();
  clockTime.dateTime = now.toISOString();
  clockTime.textContent = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: !clock24Hour,
  }).format(now);
  clockDate.textContent = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric",
  }).format(now);
};
clockFormatButton.addEventListener("click", () => {
  clock24Hour = !clock24Hour;
  clockFormatButton.textContent = clock24Hour ? "24 H" : "12 H";
  clockFormatButton.setAttribute("aria-pressed", String(!clock24Hour));
  updatePeaclock();
});
updatePeaclock();
window.setInterval(updatePeaclock, 1000);

const matrixCanvas = document.querySelector("#matrix-canvas");
const matrixContext = matrixCanvas.getContext("2d");
const matrixScreen = matrixCanvas.parentElement;
const matrixCharacters = "01アイウエオカキクケコサシスセソタチツテトナニヌネノ";
let matrixColumns = [];
let matrixFrame = 0;
let matrixVisible = true;
const resizeMatrix = () => {
  const bounds = matrixScreen.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  matrixCanvas.width = Math.max(1, Math.floor(bounds.width * ratio));
  matrixCanvas.height = Math.max(1, Math.floor(bounds.height * ratio));
  matrixContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  matrixColumns = Array.from({ length: Math.ceil(bounds.width / 15) }, () => Math.random() * -24);
};
const drawMatrix = () => {
  if (!matrixVisible || document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    matrixFrame = 0;
    return;
  }
  const width = matrixScreen.clientWidth;
  const height = matrixScreen.clientHeight;
  matrixContext.fillStyle = "rgba(4, 12, 7, .12)";
  matrixContext.fillRect(0, 0, width, height);
  matrixContext.font = "12px monospace";
  matrixContext.fillStyle = "#63d888";
  matrixColumns.forEach((row, index) => {
    const char = matrixCharacters[Math.floor(Math.random() * matrixCharacters.length)];
    matrixContext.fillText(char, index * 15, row * 15);
    if (row * 15 > height && Math.random() > .975) matrixColumns[index] = -2;
    else matrixColumns[index] += .48;
  });
  matrixFrame = window.setTimeout(drawMatrix, 70);
};
const startMatrix = () => {
  if (matrixFrame || !matrixVisible || document.hidden) return;
  matrixFrame = window.setTimeout(drawMatrix, 30);
};
resizeMatrix();
startMatrix();
if ("ResizeObserver" in window) new ResizeObserver(() => resizeMatrix()).observe(matrixScreen);
if ("IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => {
    matrixVisible = entry.isIntersecting;
    if (!matrixVisible) {
      window.clearTimeout(matrixFrame);
      matrixFrame = 0;
    } else startMatrix();
  }).observe(matrixScreen);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    window.clearTimeout(matrixFrame);
    matrixFrame = 0;
  } else startMatrix();
});
