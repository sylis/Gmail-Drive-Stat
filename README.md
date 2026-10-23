# Gmail Drive Stat

Outil de diagnostic de l'espace utilisé sur un compte Google, à la manière de WinDirStat : un treemap des e-mails Gmail et des fichiers Drive pour repérer ce qui prend de la place et faire le ménage.

*A self-hosted WinDirStat for your Google account: treemaps of Gmail and Drive usage, with cleanup. The interface is in French.*

Logiciel libre sous licence MIT, à héberger soi-même : chaque installation utilise son propre projet Google Cloud, et vos données ne quittent pas votre serveur.

État : **lots 1 à 4** livrés. Le serveur tourne dans un conteneur Docker, on s'y connecte avec son compte Google, et il affiche :

- la **vue globale** du quota : Gmail et Photos, Drive, corbeille Drive, espace libre ; un clic sur un bloc ouvre l'onglet correspondant ;
- l'onglet **Gmail** : un scan en tâche de fond lit les métadonnées des conversations, puis un treemap les range par année, trimestre et domaine d'expéditeur (ou tout autre enchaînement de niveaux), avec filtres, liste triée et plus grosses pièces jointes.

- le **nettoyage de Gmail** : on sélectionne des conversations dans le treemap ou la liste, puis on les met à la corbeille, on les supprime définitivement, on les archive ou on les marque lues ou non lues, avec simulation, suivi et journal.

- l'onglet **Drive** : un scan lit la liste de vos fichiers, puis un treemap les range par dossier (ou par type), avec la liste des plus gros fichiers, la corbeille à côté, et le même nettoyage que pour Gmail (corbeille ou suppression définitive, simulation, suivi, journal).

Restent le lot 5 (scans incrémentaux, historique, export) et Google Photos, hors périmètre pour l'instant.

## Installation

Il faut Docker et un projet Google Cloud en mode test (le guide s'affiche sur l'écran de connexion tant que les identifiants manquent). L'image est publiée pour amd64 et arm64 sur `ghcr.io/sylis/gmail-drive-stat` : `latest` pour la dernière version, `edge` pour la branche principale.

- **TrueNAS SCALE** : suivez le [guide d'installation TrueNAS](docs/installation-truenas.md), avec un script qui crée le dataset et l'application.
- **Docker Compose**, n'importe où :

```yaml
services:
  gmailstat:
    image: ghcr.io/sylis/gmail-drive-stat:latest
    env_file: .env
    environment:
      DATABASE_PATH: /data/gmailstat.sqlite
    ports:
      - "8080:8080"
    volumes:
      - gmailstat-data:/data
    restart: unless-stopped

volumes:
  gmailstat-data:
```

```sh
curl -fsSLO https://raw.githubusercontent.com/sylis/gmail-drive-stat/main/.env.example
mv .env.example .env   # puis renseignez les valeurs
docker compose up -d
```

- **Depuis les sources** : `cp .env.example .env`, renseignez les valeurs, puis `docker compose up -d --build`.

Ouvrez ensuite l'adresse indiquée dans `PUBLIC_URL` (par défaut `http://localhost:8080`).

Google n'accepte l'adresse de retour de connexion qu'en HTTPS avec un nom de domaine, sauf pour `localhost`. Pour ouvrir l'outil depuis un autre poste du réseau, placez-le derrière un proxy inverse en HTTPS et mettez cette adresse dans `PUBLIC_URL` (détails dans le [guide TrueNAS](docs/installation-truenas.md#1-choisir-ladresse-de-loutil), valables ailleurs).

### Variables d'environnement

Toute la configuration passe par des variables d'environnement, dans le fichier `.env` (exclu de Git) ou dans le YAML de TrueNAS. Le serveur refuse de démarrer si une variable obligatoire manque, et dit laquelle.

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
- L'outil demande à Google l'identité du compte, la lecture des métadonnées Drive, l'accès complet à Gmail (`https://mail.google.com/`), le seul qui permette la suppression définitive, et l'accès complet à Drive (`https://www.googleapis.com/auth/drive`), nécessaire pour mettre un fichier à la corbeille ou le supprimer. Après une mise à jour qui ajoute une autorisation, l'onglet concerné propose de se reconnecter pour l'accorder ; d'ici là, la lecture continue de fonctionner et le nettoyage se limite à la simulation.
- De Gmail, le serveur ne lit et ne conserve que des métadonnées : taille, date, expéditeur, destinataires, objet, libellés, liste de diffusion, nom, type et taille des pièces jointes. Le corps des messages et le contenu des pièces jointes ne sont jamais demandés à Google.
- De Drive, il ne lit et ne conserve que la liste des fichiers : nom, dossier, type, taille comptée dans le quota, date de modification, partage. Le contenu des fichiers n'est jamais téléchargé.
- Ces métadonnées restent dans la base SQLite du volume Docker. « Retirer l'accès » les efface avec le compte.
- Les jetons Google sont stockés chiffrés (AES-256-GCM) dans la base SQLite du volume Docker. Le bouton « Retirer l'accès » les révoque chez Google et efface le compte du serveur.
- Google ne publie pas la taille de Gmail séparément de celle de Photos : la vue globale les montre ensemble jusqu'au scan Gmail.

### Scan Gmail

Avant chaque scan, vous choisissez le périmètre : période, libellés, taille minimale des messages, et détail des pièces jointes (messages de plus de 1 Mo, ou tous). Le scan tourne sur le serveur : on peut fermer l'onglet, il reprend où il s'était arrêté après un redémarrage du conteneur ou une reconnexion. Les scans se cumulent, et un nouveau scan ne relit que les conversations nouvelles ou modifiées.

Le serveur se limite à 200 unités de quota Gmail par seconde (le plafond de Google est de 250 par utilisateur), soit une vingtaine de conversations par seconde : comptez environ une heure et demie pour 100 000 conversations. Quand Google demande de ralentir, le scan patiente et reprend seul.

Dans le treemap, une brique est une conversation ; sa taille est celle de ses messages reçus, sa couleur le type de sa plus grosse pièce jointe. Les messages envoyés et la corbeille ont leur zone à côté, d'une largeur proportionnelle à leur part de l'espace Gmail (filtres compris, zoom non compris) : on voit d'un coup d'œil ce que vider la corbeille libérerait. Un clic sur une brique affiche la conversation et ses e-mails, un clic sur l'en-tête d'un bloc (ou un double-clic dans le bloc) zoome dessus.

### Nettoyage de Gmail

**Les suppressions agissent sur votre vraie boîte.** La mise à la corbeille se restaure pendant 30 jours ; la suppression définitive ne se rattrape pas.

- **Sélection** : un clic choisit une brique, Ctrl+clic en ajoute, « Sélectionner tout le bloc » prend un domaine ou un trimestre entier, « Tout sélectionner » prend tout ce que laissent passer les filtres. Une action ne porte que sur la sélection : les messages reçus d'une brique du treemap, les messages envoyés d'une brique de la zone Envoyés.
- **Simulation** : la case « Simulation » déroule l'action sans rien envoyer à Gmail ni rien modifier, et note le résultat dans le journal.
- **Confirmation** : la corbeille demande une confirmation simple, avec un récapitulatif. La suppression définitive affiche les plus grosses conversations et exige de saisir leur nombre ; le serveur vérifie aussi ce nombre. Les conversations contenant un message important ou suivi sont signalées. Archiver et marquer lu ou non lu ne demandent pas de confirmation.
- **Exécution** : Gmail d'abord, la base ensuite. Une conversation ne bouge dans le treemap qu'une fois l'opération confirmée par Gmail ; un échec la laisse en place, encadrée de rouge, avec un bouton pour réessayer. Le traitement continue si l'onglet est fermé, et reprend après un redémarrage ou une reconnexion.
- **Journal** : chaque nettoyage, simulation comprise, y est noté avec la liste des conversations traitées. Une mise à la corbeille s'y annule avec « Restaurer ».

Le nettoyage est indisponible pendant un scan, et inversement.

### Drive

Le scan de Drive lit toute la liste en quelques dizaines d'appels (1 000 fichiers par page) : pas de périmètre à choisir, « Actualiser » relit tout. Ne sont comptés que **les fichiers dont vous êtes propriétaire**, les seuls qui occupent votre quota ; ceux qu'on a partagés avec vous n'apparaissent pas et ne sont jamais proposés à la suppression. Les documents Google (Docs, Sheets, Slides) ne pèsent rien dans le quota : ils sont comptés mais n'ont pas de brique.

- **Treemap par dossier**, comme WinDirStat : un clic sur l'en-tête d'un dossier zoome dessus, le fil d'Ariane remonte. Vos fichiers rangés dans le dossier partagé de quelqu'un d'autre sont regroupés sous « Dans des dossiers partagés ». La vue « Par type » regroupe par famille de fichiers.
- **Nettoyage** : mêmes sélection, simulation, confirmation, suivi et journal que pour Gmail, avec deux actions, la corbeille (restaurable 30 jours) et la suppression définitive. Un fichier partagé avec d'autres ou suivi est signalé avant confirmation. La zone Corbeille se sélectionne d'un clic pour la vider. Les dossiers eux-mêmes ne sont pas supprimés, seulement leurs fichiers.
- Drive supporte mal les écritures rapides : le nettoyage traite environ 4 fichiers par seconde.

## Développement

Node.js 24 ou plus récent.

```sh
npm install
npm run dev       # serveur sur le port de .env, avec rechargement
npm run dev:web   # interface sur http://localhost:5173, relayée vers le serveur
npm test          # tests du serveur
npm run demo      # l'outil complet sur un faux compte Google et une boîte fictive, sur http://localhost:8090
npm run check     # vérification des types, serveur et interface
```

En développement, déclarez aussi `http://localhost:8080/auth/callback` chez Google et ouvrez l'outil sur `PUBLIC_URL` pour la connexion.

| Dossier | Contenu |
|---|---|
| `server/src/` | Serveur TypeScript (Fastify) : configuration, connexion Google, base SQLite, quota, moteur de nettoyage commun ; `gmail/` et `drive/` pour le scan, les requêtes du treemap et le nettoyage de chaque service |
| `server/dev/` | Faux compte Google en mémoire, pour les tests et le mode démonstration |
| `web/` | Interface Svelte, treemap ECharts ; `gmail/`, `drive/` et `cleanup/` (écrans de nettoyage communs) |
| `docs/` | Feuille de route, maquette et guide d'installation TrueNAS |
| `deploy/truenas/` | Script d'installation et YAML pour TrueNAS SCALE |

## Publier une version

Une étiquette `vX.Y.Z` poussée sur GitHub construit et publie l'image `ghcr.io/sylis/gmail-drive-stat` avec les étiquettes `X.Y.Z`, `X.Y` et `latest`. Chaque push sur `main` publie `edge`.

## Documents

- [Feuille de route](docs/feuille-de-route.md) : décisions prises, phases du projet et lots de développement.
- [Maquette de l'interface](docs/maquette.html) : six écrans basse fidélité de la v1 Gmail, à ouvrir dans un navigateur. L'onglet Drive en reprend la disposition.
- [Installation sur TrueNAS SCALE](docs/installation-truenas.md).

## Licence

[MIT](LICENSE). Gmail Drive Stat n'est ni affilié à Google ni approuvé par Google.
