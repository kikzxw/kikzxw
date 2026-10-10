# KIKZXW — OSINT

Interface KIKZXW de recherche multicritère OSINT : identité, naissance, contact, localisation, comptes en ligne (Steam, FiveM, Discord, Xbox) et champs avancés (NIR, IBAN/BIC, VIN/plaque). Les requêtes sont relaisées par le serveur vers un service de recherche externe (URL par défaut codée dans le serveur, surchargeable avec la variable `SEARCH_ENDPOINT`) : le navigateur n'interroge jamais ce service directement et aucune requête n'est stockée sur le serveur.

## Démarrage

Prérequis : Node.js 18 ou plus récent.

```sh
npm start
```

Ouvrez ensuite l'adresse affichée dans la console (par défaut `http://<hôte>:3000`). Aucun paquet externe n'est nécessaire.

L'historique reste en mémoire dans l'onglet et disparaît lors de son rechargement. Chaque entrée conserve ses critères et sa réponse en mémoire : le bouton « Ouvrir » restaure la recherche et ses résultats sans relancer la requête. Les résultats ne sont pas sauvegardés sur le serveur.
La carte des résultats place les points à partir des coordonnées source ou d'une liste locale de grandes villes ; elle n'envoie aucune adresse à un service cartographique tiers. La barre latérale peut être masquée depuis l'en-tête.
Les comptes sont gérés par le serveur : la première inscription devient administrateur, les suivantes sont membres. L'authentification ouvre une session protégée par cookie ; les comptes et mots de passe hachés sont enregistrés dans le dossier de données configuré par `DATA_DIR` (par défaut `data/`) en mode Node.js. Sur Cloudflare, les comptes et sessions sont conservés dans le stockage SQLite persistant d'un Durable Object.

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Adresse d'écoute. Utilisez `127.0.0.1` pour un usage exclusivement local. |
| `PORT` | `3000` | Port d'écoute. |
| `SEARCH_ENDPOINT` | *(valeur par défaut)* | URL du service de recherche externe relaisé par `POST /api/search`. |
| `AUTH_USER` / `AUTH_PASS` | *(vide)* | Si définis, activation d'une authentification HTTP Basic sur tout le site (y compris les pages). **Fortement recommandé en public.** |
| `RATE_LIMIT_SEARCH` | `20` | Requêtes `/api/search` autorisées par IP et par minute. |
| `TRUST_PROXY` | `0` | Mettre `1` derrière un reverse proxy (Nginx, Caddy…) pour utiliser la première IP de `X-Forwarded-For` dans la limitation de débit. |
| `TLS_CERT` / `TLS_KEY` | *(vide)* | Chemins vers un certificat et une clé PEM : le serveur sert alors du HTTPS directement. Sinon, terminez TLS au niveau du reverse proxy. |

Exemple de démarrage protégé :

```sh
AUTH_USER=admin AUTH_PASS='mot-de-passe-long' npm start
```

Les en-têtes de sécurité (CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`) sont envoyés sur toutes les réponses. Seuls `index.html`, `styles.css` et `app.js` sont servis statiquement ; tout autre fichier du dépôt (dont `src/server.js`, `package.json`) renvoie un 404.

## Organisation du projet

- `index.html`, `styles.css`, `app.js` — interface web et ressources statiques à la racine.
- `src/` — serveur Node.js, Worker Cloudflare et endpoints API.
- `README.md` et `package.json` — documentation et configuration du projet.

Pour un déploiement statique Cloudflare Workers avec Wrangler, `.assetsignore` limite les ressources publiées aux fichiers de l'interface et exclut notamment `node_modules/`, qui contient des fichiers trop volumineux pour les assets Workers.

Le fichier `wrangler.jsonc` configure le Worker Cloudflare, son Durable Object `AuthStore` (comptes et sessions) et les assets du site. Le premier déploiement applique la migration SQLite automatiquement. Déployez avec `npx wrangler deploy`. Les comptes Node.js locaux et ceux de Cloudflare utilisent des stockages distincts.

## Endpoints

- `POST /api/search` — relais vers le service de recherche externe. Corps JSON acceptant les 25 critères de recherche (champs texte : identité, naissance, contact, localisation, apps et champs avancés ; entiers : `annee_naissance` 1800-2100, `jour_naissance` 1-31, `mois_naissance` 1-12) plus `page`, `per_page` (1-100) et `flexible` (booléen, recherche approximative). Les trois entiers de naissance sont convertis côté serveur en critère `date_naissance` partiel (`AAAA`, `AAAA-MM` ou `AAAA-MM-JJ`) : le service de recherche n'expose pas de champ jour/mois/année. Toute clé inconnue est ignorée, au moins un critère est requis. La réponse du service (`status`, `message`, `timestamp`, `data.results`, `meta`) est renvoyée telle quelle. Requête limitée à 20 secondes. Cette route de recherche est indépendante des routes d'authentification listées ci-dessous.
- `POST /api/auth/register` et `POST /api/auth/login` — création de compte et ouverture de session avec cookie HTTP-only, Secure en HTTPS, mot de passe haché PBKDF2-SHA-256 et limitation de tentatives.
- `GET /api/auth/me` et `POST /api/auth/logout` — vérification et fermeture de session.

Le relais refuse les réponses vides, JSON invalides ou non-objet, ainsi que celles dépassant 8 Mio. L'interface vérifie également la présence d'une liste `results` avant d'afficher un succès ; les entrées dont la forme n'est pas un objet sont ignorées avec un avertissement. Lancez `npm test` pour vérifier les routes Cloudflare d'authentification ainsi que les réponses valides et malformées du Worker.

N'utilisez l'outil que pour des recherches que vous êtes autorisé à effectuer. Avant toute exposition publique, configurez l'authentification (`AUTH_USER` / `AUTH_PASS`), terminez HTTPS (variables `TLS_CERT` / `TLS_KEY` ou reverse proxy) et ajustez la limitation de débit.
