# Feuille de route – WinDirStat pour Google

2026-10-06 · Victor Quinault

Maquette de l'interface : [maquette.html](maquette.html) (à ouvrir dans un navigateur).

Cadre retenu le 6 octobre 2026 : un outil de nettoyage à usage personnel, publié en open source, que chaque utilisateur installe avec son propre projet Google Cloud en mode test. Google Photos est hors périmètre pour l'instant.

Ce cadre supprime le principal obstacle : en mode test, aucune validation Google ni audit de sécurité n'est nécessaire. En contrepartie, chaque utilisateur doit créer son projet Google Cloud, accepter un écran « application non validée », et se reconnecter régulièrement car les autorisations en mode test expirent (7 jours, à vérifier). Le nettoyage impose des autorisations en écriture sur Gmail et Drive, ce qui est sans difficulté en mode test mais rend la sécurité des suppressions centrale.

## Décisions prises

| Sujet | Décision |
|---|---|
| Public visé | Usage personnel, projet open source, chaque installateur passe par le mode test Google |
| Types de comptes | Comptes Gmail personnels uniquement en v1 ; Workspace possible plus tard sans refonte |
| Google Photos | Mis de côté |
| Objectif | Nettoyage, pas seulement constat |
| Corbeille ou suppression | Choisi par l'utilisateur au moment de chaque nettoyage, donc accès complet à Gmail et Drive ; actions supplémentaires : archiver, marquer comme lu ou non lu |
| Architecture | Serveur dans un conteneur Docker, utilisé depuis un navigateur |
| Exposition | Réseau local au départ ; exposition sur internet plus tard via un reverse proxy géré par l'utilisateur |
| Pile technique | TypeScript (Node.js) pour le serveur, SQLite pour la base, ECharts pour le treemap, Svelte pour l'interface ; configuration et identifiants Google en variables d'environnement, hors du dépôt Git |
| Premier service | Gmail |
| Regroupements Gmail | Libellé, expéditeur, domaine, liste de diffusion, groupe de destinataires, catégorie Gmail, nombre de PJ, type de PJ, période ; chacun utilisable aussi comme filtre (période du … au …) |
| Groupes de destinataires | Exactement les mêmes personnes en À et Cc |
| Vue à l'ouverture | Année, trimestre, domaine d'expéditeur ; une brique par conversation, taille de ses messages reçus, couleur de sa plus grosse pièce jointe, gris sans pièce jointe |
| Rangement d'une conversation | Date du dernier message ; domaine qui a envoyé le plus de messages ; libellé porté par le plus de messages (les messages envoyés vont dans la zone Envoyés) |

## Prochaines décisions à trancher

1. **Licence open source** (phase 8) : peut attendre la publication.
2. **Support mobile** (phase 4) : peut attendre.

Le cadre de l'interface est tranché le 6 octobre 2026 : Svelte.

## Phase 1 : cadrage et besoins

L'objectif est de fixer ce que l'utilisateur doit pouvoir voir et faire, avant de regarder la technique.

- Lister les questions auxquelles l'outil répond : quel service occupe le plus, quels libellés ou expéditeurs pèsent le plus dans Gmail, quels dossiers et types de fichiers dans Drive, quelles pièces jointes sont les plus lourdes, combien dort dans la corbeille.
- Définir les vues attendues : vue globale par service, treemap détaillé par service, listes « top N » des plus gros éléments.
- Préciser le périmètre des comptes : Gmail personnel seul, ou aussi comptes Google Workspace (règles d'administration différentes).
- Fixer la volumétrie cible : un compte de 15 Go et un compte de 2 To avec 300 000 mails n'appellent pas la même stratégie.

**Livrables** : une fiche de besoins d'une page, une liste de cas d'usage priorisés, des comptes de test représentatifs.

**Décisions** : tranchées (usage personnel, nettoyage, comptes Gmail personnels uniquement en v1).

## Phase 2 : contraintes des API Google

Cette phase vérifie ce que Google laisse réellement lire, service par service, avant tout choix d'architecture. C'est elle qui décide si le projet est faisable sous la forme imaginée.

| Service | Mesurer la taille | Nettoyer | Limite principale |
|---|---|---|---|
| Quota global | API Drive, quota du compte (total, Drive, corbeille) | Sans objet | Totaux seulement, aucun détail |
| Gmail | API Gmail, taille estimée de chaque message | Mise à la corbeille par lot ; la suppression définitive exige l'accès complet à la boîte | Un appel par message pour lire les tailles : long pour les grosses boîtes, soumis aux quotas |
| Drive | API Drive, taille et espace compté de chaque fichier | Mise à la corbeille ou suppression, avec l'accès complet au Drive | Seuls vos propres fichiers libèrent de la place ; fichiers partagés avec vous à exclure |
| Google Photos | Hors périmètre | Hors périmètre | Visible uniquement comme reste du quota global |

Points à étudier dans cette phase :

- **Mode test, installé par chacun** : chaque utilisateur crée son projet Google Cloud, active les API Gmail et Drive, configure l'écran de consentement et s'ajoute comme testeur. Vérifier la durée de validité des autorisations en mode test et l'impact sur l'usage.
- **Pas de validation Google** : tant que l'app reste en mode test, ni vérification ni audit de sécurité ne sont requis.
- **Scopes d'écriture** : choisir le minimum pour mettre à la corbeille, et mesurer ce qu'ajouterait la suppression définitive.
- **Quotas** : mesurer le nombre d'appels et la durée d'un scan complet sur un gros compte, et le débit autorisé pour des suppressions en masse.

**Livrables** : une note de faisabilité par service, la liste des scopes retenus, une petite preuve de concept sur un compte de test pour mesurer les durées.

**Décisions** : tranché ; le choix corbeille ou suppression à l'usage impose l'accès complet à Gmail et Drive, ce qui reste possible en mode test.

Les règles citées ici sont de mémoire et datent de 2025 ; les conditions exactes (seuils, coût de l'audit, classement des scopes) sont à vérifier sur la documentation Google au démarrage de la phase.

## Phase 3 : architecture et choix techniques

Architecture retenue : un serveur livré en conteneur Docker, que chaque utilisateur héberge, et une interface web utilisée depuis le navigateur. Le serveur fait les scans et les suppressions en tâche de fond ; le navigateur affiche le treemap et pilote le nettoyage.

| Conséquence | Ce qu'il faut prévoir |
|---|---|
| Scans longs possibles | File de tâches, reprise après interruption, progression visible dans l'interface |
| Jetons Google stockés sur le serveur | Stockage chiffré, révocation depuis l'interface |
| Résultats conservables | Petite base de données locale au conteneur, permettant scans incrémentaux et historique |
| Adresse de retour OAuth | Doit correspondre à l'adresse du serveur ; simple en local, nom de domaine en HTTPS sinon |
| Distribution | Une image Docker et un fichier de configuration où chacun renseigne son propre identifiant Google |

### Options techniques

Pile retenue le 6 octobre 2026 : un seul conteneur, avec un serveur en TypeScript (Node.js), SQLite comme base, ECharts pour le treemap et Svelte pour l'interface. Passer à D3 + Canvas reste possible plus tard si le rendu doit coller davantage à WinDirStat.

**Base de données.** Elle stocke uniquement des métadonnées : quelques centaines d'octets par message, soit quelques centaines de Mo pour une très grosse boîte.

| Option | Avantages | Inconvénients | Verdict |
|---|---|---|---|
| SQLite | Un simple fichier dans un volume Docker, rien à installer, sauvegarde par copie, largement assez rapide pour un utilisateur | Une seule écriture à la fois, ce qui suffit ici | Recommandé |
| DuckDB | Très rapide pour les agrégats (sommes par domaine, par trimestre) sur des millions de lignes | Moins adapté aux écritures continues pendant un scan ; moins courant | Possible plus tard comme moteur d'analyse |
| PostgreSQL | Robuste, multi-utilisateur, standard | Un second conteneur à installer et à maintenir pour chaque installateur | Surdimensionné pour la v1 |

**Serveur.** Il pilote la connexion Google, les scans en tâche de fond et les suppressions.

| Option | Avantages | Inconvénients |
|---|---|---|
| Python (FastAPI) | Bibliothèque Google officielle, très répandu, rapide à écrire | Deux langages dans le projet (Python et JavaScript pour l'interface) |
| TypeScript (Node.js) | Un seul langage du serveur à l'interface, bibliothèque Google officielle | Écosystème plus mouvant |
| Go | Image Docker très légère, très performant pour les appels en parallèle | Plus long à écrire, moins de contributeurs potentiels |

Pour les tâches de fond, un exécuteur intégré au serveur avec l'état des scans enregistré en base suffit ; une file externe (Redis) ajouterait un conteneur sans bénéfice pour un seul utilisateur. Les requêtes groupées de l'API Gmail (jusqu'à 100 appels en une fois) réduisent fortement la durée d'un scan.

**Treemap.** Une grosse boîte peut compter plus de 100 000 conversations : dessiner chaque brique en SVG figerait le navigateur.

| Option | Avantages | Inconvénients |
|---|---|---|
| Apache ECharts | Treemap prêt à l'emploi en Canvas, avec zoom, fil d'Ariane et infobulles | Rendu moins proche de WinDirStat, personnalisation limitée |
| D3 (calcul) + Canvas (dessin) | Algorithme « squarified » de WinDirStat, contrôle total du rendu et des couleurs | Navigation et interactions à construire soi-même |
| Plotly | Simple à brancher | Lent au-delà de quelques milliers de briques |

Dans tous les cas, regrouper les toutes petites briques d'un niveau en une zone « autres » garde l'affichage fluide. Pour l'interface autour du treemap, le choix s'est porté sur Svelte (à la place de React, envisagé un temps).

### Configuration et secrets

Toute la configuration passe par des variables d'environnement, jamais écrites dans le dépôt Git. Le dépôt contient seulement un fichier modèle avec les noms des variables et des valeurs vides ; chaque installateur le copie en un fichier local, exclu de Git, que Docker charge au démarrage.

| Variable | Rôle |
|---|---|
| Identifiant client Google | Identifie le projet Google Cloud de l'installateur |
| Secret client Google | Prouve à Google que le serveur est bien celui de ce projet |
| Adresse publique du serveur | Sert à construire l'adresse de retour de la connexion Google ; à changer le jour du reverse proxy |
| Clé de chiffrement | Chiffre les jetons Google stockés en base |
| Adresses Google autorisées | Pas de mot de passe propre à l'outil : l'accès s'ouvre dès la connexion Google. Cette liste réserve l'accès aux comptes prévus, en plus des testeurs déclarés dans le projet Google |
| Port et emplacement de la base | Réglages d'installation |

Les jetons d'accès obtenus après connexion ne sont pas des variables d'environnement : ils changent à chaque connexion et sont stockés chiffrés en base. Le serveur refuse de démarrer si une variable obligatoire manque, avec un message qui dit laquelle.

### Récupération des métadonnées Gmail

Les métadonnées sont copiées une fois dans la base locale, puis tenues à jour par une synchronisation incrémentale. Le treemap et les filtres lisent uniquement la base locale, jamais Gmail en direct.

**Périmètre du scan.** Avant de lancer un scan, l'utilisateur choisit ce qu'il veut analyser : les X derniers jours, une période du … au …, un ou plusieurs libellés, et éventuellement une taille minimale de message. La recherche de Gmail sait déjà filtrer sur ces critères, donc seuls les messages concernés sont lus : un périmètre réduit raccourcit directement le scan.

- **Bouton Actualiser** : il rouvre la question du périmètre, préremplie avec le dernier choix ; l'utilisateur valide tel quel ou modifie, puis seuls les changements sont relus.
- **Périmètres cumulables** : un second scan sur une autre période ou un autre libellé complète la base sans tout relire, et l'interface montre ce qui a déjà été scanné.
- **Périmètre toujours affiché** : le treemap indique clairement qu'il ne couvre qu'une partie de la boîte, et la comparaison au quota total le signale.
- **Conversations à cheval sur la limite** : une conversation dont un message tombe dans le périmètre est lue en entier, sinon sa taille serait sous-estimée.
- **Taille minimale** : scanner d'abord les messages de plus de 1 Mo (par exemple) trouve vite l'essentiel de l'espace récupérable.

1. **Scan initial** : lister tous les identifiants de messages par pages, puis lire pour chacun sa taille, ses libellés, sa conversation, sa date et les en-têtes utiles (De, À, Cc, liste de diffusion). La structure des pièces jointes (type, taille de chaque PJ) demande une lecture plus détaillée : on peut la réserver aux messages au-dessus d'un seuil de taille pour gagner du temps, au prix d'un comptage de PJ incomplet sur les petits messages.
2. **Synchronisation incrémentale** : Gmail fournit un historique des changements (messages ajoutés, supprimés, libellés modifiés) depuis un point de repère. On ne relit que ce qui a changé. Si le repère est trop ancien (environ une semaine, à vérifier), Gmail le refuse et il faut refaire un scan complet.
3. **Après un nettoyage** : chaque action déclenche deux opérations, d'abord sur le compte Gmail, puis sur la base locale. La base n'est modifiée, conversation par conversation, qu'une fois que Gmail a confirmé le traitement ; un échec laisse la conversation inchangée et la signale. L'affichage reflète donc toujours ce qui a vraiment été traité sur le compte. Si le serveur s'arrête en cours de route, la synchronisation suivante remet la base en cohérence. Une conversation mise à la corbeille reste comptée dans le quota Google tant que la corbeille n'est pas vidée (30 jours) : elle passe dans une zone « corbeille » repliable, à côté du treemap, au lieu de disparaître.

**Limites d'usage Gmail.** Gmail impose une limite par utilisateur et par seconde, exprimée en unités de quota ; lire un message coûte quelques unités. D'après ma mémoire, cela donne de l'ordre de 50 lectures par seconde, soit au moins 30 à 60 minutes pour un scan initial de 100 000 messages (chiffres à vérifier dans la documentation Gmail). Le quota journalier global du projet est très large et ne devrait pas être un frein pour un utilisateur.

Ce qu'il faut concevoir :

- **Régulation du débit** : le serveur limite lui-même son rythme d'appels sous le plafond Gmail.
- **Requêtes groupées** : plusieurs lectures envoyées en une seule requête.
- **Nouvelle tentative avec attente croissante** quand Gmail répond « trop de requêtes ».
- **Reprise** : l'avancement du scan est enregistré en base ; après un redémarrage du conteneur, il reprend là où il s'était arrêté.
- **Autorisation expirée** : en mode test, l'autorisation Google expire régulièrement ; le scan se met en pause et l'interface demande de se reconnecter.
- **Suppressions en masse** : Gmail permet de supprimer définitivement des messages par lots ; la mise à la corbeille se fait message par message ou conversation par conversation, donc elle est soumise au même débit (à vérifier).

Autres choix à arrêter :

- Mise en cache des résultats d'un scan (rien, stockage local du navigateur, ou serveur).
- Scan complet ou incrémental (relire seulement ce qui a changé depuis la dernière fois).
- Pile technique et bibliothèque de visualisation, choisies une fois l'option ci-dessus retenue.

**Livrables** : un schéma d'architecture, une note de choix techniques motivée.

**Décisions** : tranchées (réseau local, TypeScript, SQLite, ECharts, Svelte pour l'interface). À prévoir dès maintenant : une adresse publique configurable, pour que la connexion Google fonctionne le jour où le serveur passe derrière le reverse proxy.

## Phase 4 : conception UX

L'écran central est un treemap à la WinDirStat, mais il faut d'abord décider ce qu'est un « dossier » pour Gmail, qui n'a pas d'arborescence.

- **Hiérarchie Gmail** : neuf axes de regroupement, détaillés dans le tableau ci-dessous. L'utilisateur choisit l'axe, ou en combine plusieurs comme niveaux du treemap (par exemple domaine, puis expéditeur, puis année).
- **Hiérarchie Drive** : par dossier (proche de WinDirStat), avec une vue alternative par type de fichier.
- **Niveau global** : Gmail, Drive, Photos et corbeille côte à côte, comparés au quota total.
- **Navigation** : zoom dans une zone, fil d'Ariane pour remonter, bascule entre treemap et liste triée (l'un ou l'autre, avec les mêmes filtres et la même sélection), couleurs par type comme dans WinDirStat, et deux zones repliables à côté du treemap : « Envoyés » (messages du libellé Sent, regroupés par conversation ; le treemap principal ne montre que les messages reçus) et « Corbeille ».
- **Pendant le scan** : barre de progression, résultats qui se remplissent au fur et à mesure, possibilité d'interrompre.
- **Nettoyage** : sélection d'éléments ou de zones entières du treemap dans un panier, liste des e-mails de la sélection sous la zone principale (De, À, Objet, nombre de pièces jointes, poids), récapitulatif de l'espace libéré avant confirmation, avec le choix de l'action : mise à la corbeille, suppression définitive, archivage (retrait de la boîte de réception), marquer comme lu ou non lu. Seules les deux premières libèrent de la place ; archivage et lu/non lu servent au tri et sont appliqués par lots, suivi de l'exécution, et lien pour ouvrir chaque élément dans Gmail ou Drive avant de décider.
- **Mobile** : consultation simple ou bureau uniquement.

### Vue Gmail à l'ouverture

Comme dans WinDirStat, la vue d'ouverture montre à la fois une hiérarchie, une taille et une couleur.

| Élément | Règle |
|---|---|
| Niveau 1 | Année |
| Niveau 2 | Trimestre |
| Niveau 3 | Domaine d'expéditeur |
| Brique | Une conversation (chaîne d'emails), pas un message isolé |
| Taille de la brique | Taille totale de la conversation |
| Couleur de la brique | Type de la plus grosse pièce jointe de la conversation (deux photos et une grosse vidéo : couleur vidéo) ; gris sans pièce jointe |
| Date de la conversation | Date de son dernier message |
| Domaine de la conversation | Le domaine qui a envoyé le plus de messages dans la conversation ; en cas d'égalité, celui qui revient le plus dans les adresses citées |

Conséquence pour le nettoyage : supprimer une brique supprime les messages qu'elle représente : les messages reçus dans le treemap, les messages envoyés dans la zone Envoyés ; pour étendre la sélection, le panneau de détail propose « Sélectionner toute la conversation » (reçus et envoyés) et « Sélectionner tout le bloc ». L'API Gmail le permet message par message.

Ces deux dernières règles rangent chaque conversation à une seule place, même si elle s'étend sur plusieurs trimestres ou mêle plusieurs domaines.

### Axes de regroupement Gmail

| Axe | Ce qui est regroupé | Donnée lue dans le message | Point d'attention |
|---|---|---|---|
| Libellé | Les libellés Gmail, avec leurs sous-libellés comme une arborescence de répertoires | Libellés du message | Une conversation à plusieurs libellés est rangée sous celui porté par le plus de messages ; les libellés système comptent comme les autres, sauf Envoyés qui a sa propre zone |
| Expéditeur | Tous les messages d'une même adresse | Champ De | Une même personne peut avoir plusieurs adresses |
| Domaine d'expéditeur | Toutes les adresses d'un même domaine | Champ De | Regrouper les sous-domaines ou non (news.site.fr et site.fr) ; isoler les domaines grand public comme gmail.com |
| Liste de diffusion | Newsletters, notifications, listes | En-tête d'identification de liste et lien de désabonnement | Tous les envois en masse ne le renseignent pas |
| Groupe de destinataires | Messages envoyés exactement aux mêmes personnes en À et Cc | Champs À et Cc | Aucun recouvrement entre groupes ; surtout parlant pour les messages envoyés |
| Catégorie Gmail | Principale, Promotions, Réseaux sociaux, Notifications, Forums | Catégorie attribuée par Gmail | Dépend du classement de Google, absent si les onglets sont désactivés (à vérifier) |
| Nombre de pièces jointes | Messages sans, avec 1, 2 à 5, plus de 5 PJ | Structure du message | Lire la structure coûte plus cher que les seuls en-têtes |
| Type de fichier joint | PDF, images, vidéos, archives, documents bureautiques | Structure du message (type et taille de chaque PJ) | Un message à plusieurs types : répartir sa taille par pièce jointe |
| Période | Année, trimestre, mois | Date du dernier message de la conversation | Aucun |

Deux règles transverses s'appliquent. Chaque conversation est rangée à une seule place par axe, pour que la somme des zones égale toujours l'espace réel. Et le nettoyage d'une zone supprime le message entier, pas seulement ses pièces jointes, ce qui doit être clair dans les vues par type de fichier.

### Filtres

Chaque axe peut aussi servir de filtre. Les filtres se cumulent, le treemap se recalcule sur les seules conversations retenues, et un nettoyage ne porte que sur les conversations sélectionnées (un bouton « Tout sélectionner » prend tout ce qui est filtré).

| Axe | Type de filtre |
|---|---|
| Période | Intervalle de dates, du … au … |
| Libellé | Sélection multiple dans l'arborescence |
| Expéditeur, domaine, liste de diffusion, groupe de destinataires | Sélection multiple avec recherche, inclure ou exclure |
| Catégorie Gmail, type de fichier joint | Cases à cocher |
| Nombre de pièces jointes | Intervalle, de … à … |
| Taille de la conversation (filtre en plus des axes) | Taille minimale, par exemple plus de 5 Mo |

Les filtres actifs restent visibles au-dessus du treemap et s'enlèvent en un clic. Le filtre de période s'applique à la date de la conversation, c'est-à-dire celle de son dernier message.

**Livrables** : parcours utilisateur, maquettes basse fidélité, puis une maquette cliquable testée sur 2 ou 3 personnes.

**Maquette basse fidélité** : première version du [wireframe](maquette.html) (six écrans de la v1 Gmail), avec dix questions d'ergonomie à trancher.

**Décisions** : vue d'ouverture et règles de rangement tranchées ; reste le support mobile ou non.

## Phase 5 : sécurité et confidentialité

L'outil voit qui écrit à l'utilisateur et ce qu'il stocke : la confiance est la condition pour que quelqu'un se connecte, et Google l'exige pour valider l'app.

- **Minimisation** : lire uniquement les métadonnées (taille, date, expéditeur, libellé), jamais le contenu des mails ni des fichiers, même si l'accès complet le permettrait.
- **Suppressions sûres** : corbeille proposée par défaut, suppression définitive avec une confirmation renforcée, récapitulatif obligatoire avant toute action groupée, journal de ce qui a été supprimé, mode simulation.
- **Exclusions** : ne jamais proposer la suppression de fichiers partagés avec vous ou de messages marqués importants sans avertissement explicite.
- **Serveur** : jetons Google chiffrés au repos, accès à l'interface uniquement après connexion avec un compte Google autorisé, sans mot de passe propre à l'outil, HTTPS obligatoire si exposée sur internet.
- **Données conservées** : uniquement des métadonnées, dans le conteneur de l'utilisateur, avec un bouton pour tout effacer.
- **Open source** : aucun identifiant Google ni secret dans le dépôt, chaque installateur utilise le sien ; politique de confidentialité courte dans le README.

**Livrables** : une analyse de risques courte, la politique de confidentialité, la liste des données manipulées et leur durée de vie.

**Décisions** : forme de la confirmation renforcée, éléments toujours protégés, durée de conservation des résultats.

## Phase 6 : développement par lots

Chaque lot livre quelque chose d'utilisable, du plus simple et du moins risqué au plus sensible.

1. **Lot 1, socle et vue globale** : conteneur Docker, connexion Google, répartition du quota entre Gmail, Drive, corbeille et le reste (dont Photos).
2. **Lot 2, Gmail** : scan des messages en tâche de fond, treemap par expéditeur, libellé ou année, plus grosses pièces jointes.
3. **Lot 3, nettoyage Gmail** : panier de sélection, simulation, corbeille ou suppression définitive au choix, archivage, marquer comme lu ou non lu, journal des actions.
4. **Lot 4, Drive** : scan des fichiers, treemap par dossier, plus gros fichiers, puis nettoyage avec le même mécanisme.
5. **Lot 5, confort** : scans incrémentaux, historique de l'espace dans le temps, export des résultats.
6. **Plus tard** : Google Photos, si l'API ou un import Takeout le permettent.

**Livrables** : une version démontrable à la fin de chaque lot.

**Décisions** : tranché, Gmail en premier ; le nettoyage arrive juste après le scan Gmail pour avoir un outil utile au plus tôt.

## Phase 7 : tests

Le risque principal n'est pas un bug d'affichage mais un total faux ou un scan qui n'aboutit pas sur un gros compte.

- **Exactitude** : comparer les totaux de l'outil avec ceux affichés par Google One et la page de stockage Google.
- **Volumétrie** : un petit compte, un compte moyen, un compte très chargé (centaines de milliers de mails, gros Drive).
- **Robustesse** : quotas dépassés, coupure réseau, autorisation révoquée en cours de scan.
- **Cas particuliers** : fichiers partagés, Google Docs natifs, messages à plusieurs libellés, corbeille et spam.
- **Utilisateurs** : quelques testeurs réels sur la compréhension du treemap.

**Livrables** : un plan de test, des comptes de test préparés, un compte rendu des écarts constatés.

**Décisions** : tolérance d'écart acceptable avec les chiffres Google.

## Phase 8 : publication open source

Il n'y a pas de validation Google à passer : la mise en ligne consiste à publier le projet open source avec un guide d'installation assez clair pour qu'un non-développeur crée son propre accès Google.

1. Choisir la licence et publier le dépôt.
2. Rédiger le guide pas à pas : création du projet Google Cloud, activation des API Gmail et Drive, écran de consentement en mode test, ajout de soi-même comme testeur, création de l'identifiant OAuth. Une version courte s'affiche aussi sur l'écran de connexion tant que les identifiants manquent.
3. Expliquer l'écran « application non validée » et la reconnexion périodique, pour ne pas inquiéter l'utilisateur.
4. Publier l'image Docker avec un exemple de configuration prêt à l'emploi.
5. Faire tester l'installation par une personne extérieure au projet, puis corriger le guide.

**Livrables** : dépôt public, guide d'installation illustré, README avec avertissements sur les suppressions.

**Décisions** : licence, registre où publier l'image Docker.
