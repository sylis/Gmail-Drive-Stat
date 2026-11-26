# Installer Gmail Drive Stat sur TrueNAS SCALE

Ce guide vaut pour TrueNAS SCALE 24.10 (« Electric Eel ») et les versions suivantes, où les applications tournent sous Docker. L'outil y est installé comme **application personnalisée**, à partir de l'image publiée sur GitHub Container Registry : `ghcr.io/sylis/gmail-drive-stat`.

Comptez une demi-heure, dont l'essentiel pour le projet Google Cloud.

## 1. Choisir l'adresse de l'outil

Google n'accepte une adresse de retour de connexion qu'en **HTTPS** et sur un **nom de domaine**, sauf pour `localhost`. Une adresse comme `http://192.168.1.20:8080` est refusée. Il faut donc ouvrir l'outil par une adresse HTTPS, par exemple `https://gmailstat.mondomaine.fr`, servie par un proxy inverse qui relaie vers le port de l'application sur TrueNAS. Trois façons courantes :

- **Un proxy inverse que vous avez déjà** (Nginx Proxy Manager, Caddy, Traefik, celui de votre box) avec un nom de domaine et un certificat Let's Encrypt. Le domaine n'a pas besoin d'être joignable depuis Internet : un certificat obtenu par validation DNS suffit, et le nom peut ne pointer que vers l'adresse locale de TrueNAS.
- **Tailscale** (application du catalogue TrueNAS) : `tailscale serve` publie l'outil en HTTPS sur une adresse en `https://<machine>.<tailnet>.ts.net`, accessible depuis vos appareils connectés à Tailscale.
- **Pour un simple essai**, un tunnel SSH depuis votre ordinateur : `ssh -L 8080:localhost:8080 admin@<ip-de-truenas>`, avec `PUBLIC_URL=http://localhost:8080`. L'outil ne marche alors que tant que le tunnel est ouvert.

Cette adresse sera `PUBLIC_URL`, et l'adresse de retour à déclarer chez Google sera `<PUBLIC_URL>/auth/callback`.

## 2. Créer le projet Google Cloud

Chaque installation utilise son propre projet Google Cloud, en mode test : pas de validation par Google, mais seules les adresses déclarées comme utilisateurs test peuvent se connecter.

1. Sur [console.cloud.google.com](https://console.cloud.google.com), créez un projet, par exemple « Gmail Drive Stat ».
2. Dans **API et services › Bibliothèque**, activez **Gmail API** et **Google Drive API**.
3. Dans **Écran de consentement OAuth** (ou **Google Auth Platform**), choisissez le type **Externe**, donnez un nom et votre e-mail de contact, et laissez l'application **en mode Test**.
4. Dans **Audience › Utilisateurs test**, ajoutez chaque adresse Gmail qui utilisera l'outil.
5. Dans **Accès aux données**, ajoutez les champs d'application `https://mail.google.com/` et `https://www.googleapis.com/auth/drive`.
6. Dans **Identifiants › Créer des identifiants › ID client OAuth**, choisissez **Application Web** et ajoutez l'URI de redirection `<PUBLIC_URL>/auth/callback`.
7. Notez l'**ID client** et le **code secret**.

Vous pouvez aussi installer l'outil d'abord : tant que les identifiants manquent, il affiche ce guide avec l'adresse exacte à copier.

En mode test, Google fait expirer l'autorisation au bout de 7 jours : l'outil propose alors de se reconnecter, sans rien perdre.

## 3. Installer l'application

### Avec le script (recommandé)

Dans l'interface de TrueNAS, ouvrez **System › Shell** et lancez :

```sh
curl -fsSL https://raw.githubusercontent.com/sylis/gmail-drive-stat/main/deploy/truenas/install.sh -o install-gmailstat.sh
sudo bash install-gmailstat.sh
```

Le script :

1. crée un dataset pour la base SQLite (par défaut `<pool>/apps/gmail-drive-stat`) et le donne à l'utilisateur `apps` (568) ;
2. génère la clé de chiffrement des jetons Google et la garde dans le dataset, dans `.encryption-key` ;
3. demande `PUBLIC_URL`, le port, les adresses autorisées et les identifiants Google (qu'on peut laisser vides pour plus tard) ;
4. déclare l'application `gmail-drive-stat` auprès de TrueNAS, qui télécharge l'image et la démarre.

L'application apparaît ensuite dans **Apps**, comme les autres. Si TrueNAS refuse la création automatique, le script affiche le YAML à coller à la main (voir ci-dessous).

### À la main

1. Dans **Datasets**, créez un dataset, par exemple `tank/apps/gmail-drive-stat`, puis dans ses permissions donnez-le à l'utilisateur et au groupe `apps`.
2. Générez une clé de chiffrement, par exemple dans le shell : `openssl rand -base64 32`.
3. Dans **Apps › Discover Apps**, ouvrez le menu **⋮** puis **Install via YAML**. Nommez l'application `gmail-drive-stat` et collez le contenu de [`deploy/truenas/compose.yaml`](../deploy/truenas/compose.yaml), en remplaçant les valeurs entre `< >`.

## 4. Relier le proxy inverse et se connecter

Faites pointer votre proxy inverse vers `http://<ip-de-truenas>:8080` (ou le port choisi), puis ouvrez `PUBLIC_URL` et connectez-vous avec une adresse de `ALLOWED_EMAILS`.

## Modifier, mettre à jour, sauvegarder

- **Modifier un réglage** (identifiants Google, adresses autorisées…) : **Apps › gmail-drive-stat › Edit**, changez la valeur dans le YAML et enregistrez ; l'application redémarre.
- **Mettre à jour** : l'étiquette `latest` suit la dernière version publiée. TrueNAS signale une mise à jour quand une image plus récente existe ; vous pouvez aussi fixer une version précise (`ghcr.io/sylis/gmail-drive-stat:0.2.0`) dans le YAML et la changer à chaque nouvelle version. L'étiquette `edge` suit la branche principale, pour qui veut les nouveautés avant leur publication.
- **Sauvegarder** : tout l'état est dans le dataset (base SQLite et clé de chiffrement). Un instantané ZFS suffit. Ne changez pas `ENCRYPTION_KEY` après coup : les jetons Google enregistrés deviendraient illisibles et il faudrait se reconnecter.
- **Désinstaller** : supprimez l'application dans **Apps**, puis le dataset. Pensez aussi à retirer l'accès de l'outil dans votre compte Google (bouton « Retirer l'accès » avant de désinstaller, ou [myaccount.google.com/permissions](https://myaccount.google.com/permissions)).

## En cas de problème

- **L'application ne démarre pas** : ouvrez ses journaux dans **Apps**. Le serveur dit quelle variable manque ou est invalide.
- **« Permission denied » sur `/data`** : le dataset n'appartient pas à l'utilisateur `apps` (568). Corrigez ses permissions ou relancez le script.
- **Google affiche « redirect_uri_mismatch »** : l'URI déclarée chez Google doit être exactement `<PUBLIC_URL>/auth/callback`, avec le même protocole, le même nom et le même port.
- **Google affiche « Accès bloqué »** : l'adresse n'est pas dans les utilisateurs test du projet Google Cloud.
- **« Origine refusée » sur les actions** : l'adresse dans la barre du navigateur n'est pas exactement `PUBLIC_URL`.
