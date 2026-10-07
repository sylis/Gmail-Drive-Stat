# Gmail Drive Stat

Outil de diagnostic de l'espace utilisé sur un compte Google, à la manière de WinDirStat : un treemap des e-mails Gmail (puis des fichiers Drive) pour repérer ce qui prend de la place et faire le ménage.

État : **lot 1** livré (socle et vue globale). Le serveur tourne dans un conteneur Docker, on s'y connecte avec son compte Google, et il affiche la répartition du quota entre Gmail et Photos, Drive, la corbeille Drive et l'espace libre. Le scan Gmail arrive au lot 2.

## Démarrage

Il faut Docker et un projet Google Cloud en mode test (le guide s'affiche sur l'écran de connexion tant que les identifiants manquent).

```sh
cp .env.example .env   # puis renseignez les valeurs
docker compose up -d --build
```

Ouvrez ensuite l'adresse indiquée dans `PUBLIC_URL` (par défaut `http://localhost:8080`).

### Variables d'environnement

Toute la configuration passe par le fichier `.env`, exclu de Git. Le serveur refuse de démarrer si une variable obligatoire manque, et dit laquelle.

| Variable | Obligatoire | Rôle |
|---|---|---|
| `PUBLIC_URL` | oui | Adresse à laquelle on ouvre l'outil. L'adresse de retour à déclarer chez Google est `<PUBLIC_URL>/auth/callback`. |
| `ENCRYPTION_KEY` | oui | Clé qui chiffre les jetons Google en base, au moins 32 caractères (`openssl rand -base64 32`). |
| `ALLOWED_EMAILS` | oui | Adresses Google autorisées à se connecter, séparées par des virgules. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | pour se connecter | Identifiants OAuth du projet Google Cloud. Vides, le serveur démarre et affiche le guide d'installation. |
| `PORT` | non | Port d'écoute, 8080 par défaut. |
| `DATABASE_PATH` | non | Emplacement du fichier SQLite. Dans Docker, il est fixé à `/data/gmailstat.sqlite`, dans le volume `gmailstat-data`. |

### Accès et données

- Il n'y a pas de mot de passe propre à l'outil : seule une connexion Google avec une adresse de `ALLOWED_EMAILS` ouvre l'interface.
- Le lot 1 ne demande à Google que l'identité du compte et la lecture des métadonnées Drive (pour le quota). Les accès Gmail et Drive complets seront demandés par les lots suivants.
- Les jetons Google sont stockés chiffrés (AES-256-GCM) dans la base SQLite du volume Docker. Le bouton « Retirer l'accès » les révoque chez Google et efface le compte du serveur.
- Google ne publie pas la taille de Gmail séparément de celle de Photos : la vue globale les montre ensemble jusqu'au scan Gmail.

## Développement

Node.js 24 ou plus récent.

```sh
npm install
npm run dev       # serveur sur le port de .env, avec rechargement
npm run dev:web   # interface sur http://localhost:5173, relayée vers le serveur
npm test          # tests du serveur
npm run check     # vérification des types, serveur et interface
```

En développement, déclarez aussi `http://localhost:8080/auth/callback` chez Google et ouvrez l'outil sur `PUBLIC_URL` pour la connexion.

| Dossier | Contenu |
|---|---|
| `server/` | Serveur TypeScript (Fastify) : configuration, connexion Google, base SQLite, API du quota |
| `web/` | Interface Svelte, treemap ECharts |
| `docs/` | Feuille de route et maquette |

## Documents

- [Feuille de route](docs/feuille-de-route.md) : décisions prises, phases du projet et lots de développement.
- [Maquette de l'interface](docs/maquette.html) : six écrans basse fidélité de la v1 Gmail, à ouvrir dans un navigateur.
