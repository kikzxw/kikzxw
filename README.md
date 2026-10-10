# KIKZXW — OSINT

Interface KIKZXW de recherche multicritère OSINT : identité, naissance, contact, localisation, comptes en ligne (Steam, FiveM, Discord, Xbox) et champs avancés (NIR, IBAN/BIC, VIN/plaque). Les requêtes sont relaisées par le serveur vers un service de recherche externe (URL par défaut codée dans le serveur, surchargeable avec la variable `SEARCH_ENDPOINT`) : le navigateur n'interroge jamais ce service directement et aucune requête n'est stockée sur le serveur.

## Démarrage

Prérequis : Node.js 18 ou plus récent.

```sh
npm start
```

Ouvrez ensuite l'adresse affichée dans la console (par défaut `http://<hôte>:3000`). Aucun paquet externe n'est nécessaire.

L'historique reste en mémoire dans l'onglet et disparaît lors de son rechargement. Chaque entrée conserve ses critères et sa réponse en mémoire : le bouton « Ouvrir » restaure la recherche et ses résultats sans relancer la requête. Les résultats ne sont pas sauvegardés sur le serveur.
La carte des résultats affiche les coordonnées source ou celles des villes reconnues localement sur un fond topographique interactif OpenTopoMap (relief SRTM). Le fournisseur de cartes reçoit les tuiles demandées et peut donc déduire les zones consultées; aucune adresse n'est envoyée pour géocodage. La carte permet le zoom, le déplacement et le recadrage sur les résultats. La barre latérale peut être masquée depuis l'en-tête.
Les comptes et les sessions sont gérés côté serveur. Le premier compte administrateur doit être provisionné par l'exploitant avec un jeton secret à usage unique; une inscription publique ne peut pas s'attribuer ce rôle. Après ce provisionnement, les inscriptions normales créent des membres. Les mots de passe sont hachés et les sessions sont protégées par cookie HTTP-only. En mode Node.js, les comptes sont enregistrés dans `DATA_DIR` (par défaut `data/`); sur Cloudflare, les comptes et sessions sont conservés dans le stockage SQLite persistant d'un Durable Object.

Pour créer le premier administrateur, générez et conservez un jeton aléatoire d'au moins 32 octets dans un gestionnaire de secrets, puis configurez-le comme `ADMIN_BOOTSTRAP_TOKEN`. Après le démarrage du serveur (ou le déploiement et la configuration du secret Cloudflare), envoyez une seule inscription contenant ce jeton :

```sh
curl --fail-with-body -X POST 'https://<hôte>/api/auth/register' \
  -H 'Content-Type: application/json' \
  --data '{"username":"admin_initial","password":"<mot-de-passe-long>","bootstrapToken":"<ADMIN_BOOTSTRAP_TOKEN>"}'
```

Cette route ne consomme le jeton que si aucun compte n'existe; les comptes suivants reçoivent le rôle membre. Le jeton n'est jamais embarqué dans l'interface web.

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Adresse d'écoute. Utilisez `127.0.0.1` pour un usage exclusivement local. |
| `PORT` | `3000` | Port d'écoute. |
| `SEARCH_ENDPOINT` | *(valeur par défaut)* | URL du service de recherche externe relaisé par `POST /api/search`. |
| `ADMIN_BOOTSTRAP_TOKEN` | *(vide)* | Secret requis pour créer le tout premier administrateur. Gardez-le dans un gestionnaire de secrets; ne le publiez pas dans l'interface. |
| `AUTH_USER` / `AUTH_PASS` | *(vide)* | Si définis, authentification HTTP Basic supplémentaire sur tout le site (y compris les pages). |
| `RATE_LIMIT_SEARCH` | `20` | En mode Node.js, recherches autorisées par IP et par minute; le compteur est local au processus. |
| `TRUST_PROXY` | `0` | Mettre `1` uniquement derrière un reverse proxy de confiance : utilise la première IP de `X-Forwarded-For` pour la limitation et `X-Forwarded-Proto: https` pour poser `Secure` sur les cookies. |
| `TLS_CERT` / `TLS_KEY` | *(vide)* | Chemins vers un certificat et une clé PEM : le serveur sert alors du HTTPS directement. Sinon, terminez TLS au niveau du reverse proxy. |

Exemple de démarrage local avec un secret d'amorçage (stockez sa valeur de façon sûre pour l'inscription initiale) :

```sh
export ADMIN_BOOTSTRAP_TOKEN='<jeton aléatoire de 32 octets conservé dans le gestionnaire de secrets>'
npm start
```

En mode Cloudflare, configurez le même secret sans le placer dans `wrangler.jsonc` :

```sh
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
```

`POST /api/search` exige une session valide (membre ou administrateur). Le Worker utilise le binding Cloudflare `SEARCH_RATE_LIMITER` configuré pour 20 recherches par adresse IP sur 60 secondes; Cloudflare applique ce compteur par emplacement réseau, et non par instance Worker. Sans ce binding, le Worker échoue fermé avec `503`. Le serveur Node conserve sa limitation locale en mémoire, qui n'est pas partagée entre plusieurs processus.

Les réponses Node et Worker ajoutent une CSP restrictive, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` et `Referrer-Policy: no-referrer`. La CSP autorise les styles et polices Google utilisés dans l'en-tête HTML, les tuiles cartographiques OpenTopoMap et aucun script tiers ou inline. Les réponses API et erreurs ne sont pas mises en cache; `index.html` est revalidé, tandis que `styles.css` et `app.js` sont mis en cache cinq minutes. Seuls `index.html`, `styles.css` et `app.js` sont servis statiquement par Node; tout autre fichier du dépôt (dont `src/server.js`, `package.json`) renvoie un 404 avec les en-têtes de sécurité.

Le serveur Node fournit aussi `/api/admin/*` et `/api/saved/*` avec des contrôles de session et de rôle. Le Worker Cloudflare ne fournit actuellement que `/api/auth/*` et `/api/search`; les routes d'administration et de sauvegarde y répondent explicitement `404` et ne sont pas relayées aux assets.

## Organisation du projet

- `index.html`, `styles.css`, `app.js` — interface web et ressources statiques à la racine.
- `src/` — serveur Node.js, Worker Cloudflare et endpoints API.
- `README.md` et `package.json` — documentation et configuration du projet.

Pour un déploiement statique Cloudflare Workers avec Wrangler, `.assetsignore` limite les ressources publiées aux fichiers de l'interface et exclut notamment `node_modules/`, qui contient des fichiers trop volumineux pour les assets Workers.

Le fichier `wrangler.jsonc` configure le Worker Cloudflare, son Durable Object `AuthStore` (comptes et sessions) et les assets du site. Le premier déploiement applique la migration SQLite automatiquement. Déployez avec `npx wrangler deploy`. Les comptes Node.js locaux et ceux de Cloudflare utilisent des stockages distincts.

## Endpoints

- `POST /api/search` — relais vers le service de recherche externe après vérification obligatoire de la session. Corps JSON acceptant les 25 critères de recherche (champs texte : identité, naissance, contact, localisation, apps et champs avancés ; entiers : `annee_naissance` 1800-2100, `jour_naissance` 1-31, `mois_naissance` 1-12) plus `page`, `per_page` (1-100) et `flexible` (booléen, recherche approximative). Les trois entiers de naissance sont convertis côté serveur en critère `date_naissance` partiel (`AAAA`, `AAAA-MM` ou `AAAA-MM-JJ`) : le service de recherche n'expose pas de champ jour/mois/année. Toute clé inconnue est ignorée, au moins un critère est requis. La réponse du service (`status`, `message`, `timestamp`, `data.results`, `meta`) est renvoyée telle quelle. Requête limitée à 20 secondes. Le Worker limite aussi les demandes au moyen du binding Cloudflare, indépendamment de la session.
- `POST /api/auth/register` et `POST /api/auth/login` — création de compte et ouverture de session avec cookie HTTP-only, `Secure` en HTTPS direct ou derrière un proxy de confiance configuré, mot de passe haché PBKDF2-SHA-256 et limitation de tentatives.
- `GET /api/auth/me` et `POST /api/auth/logout` — vérification et fermeture de session.

Le relais refuse les réponses vides, JSON invalides ou non-objet, ainsi que celles dépassant 8 Mio. L'interface vérifie également la présence d'une liste `results` avant d'afficher un succès ; les entrées dont la forme n'est pas un objet sont ignorées avec un avertissement. Lancez `npm test` pour vérifier les routes Cloudflare d'authentification ainsi que les réponses valides et malformées du Worker.

N'utilisez l'outil que pour des recherches que vous êtes autorisé à effectuer. Avant toute exposition publique, provisionnez l'administrateur avec un jeton secret, terminez HTTPS (variables `TLS_CERT` / `TLS_KEY` ou reverse proxy) et ajustez la limitation de débit. `AUTH_USER` / `AUTH_PASS` ajoutent une protection HTTP Basic globale, mais ne remplacent pas la session applicative.
