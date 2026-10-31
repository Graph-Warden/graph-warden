<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
    <img src="docs/assets/banner-light.png" alt="Graph-Warden : graphe de connaissance gouverné pour agents IA" width="720">
  </picture>
</p>

<p align="center"><a href="README.md">English</a> · <b>Français</b></p>

# Graph-Warden

**Un seul graphe de connaissance pour les agents IA de toutes les équipes, avec des droits vérifiés à chaque saut.**

Graph-Warden rassemble ce que les équipes écrivent déjà (dépôts, specs d'API, documentation, sessions d'agents), le relie en un graphe typé, et permet aux agents IA de l'interroger. Chaque requête est faite au nom d'une personne, ne renvoie que ce que cette personne a le droit de voir, et est enregistrée.

> Statut : **alpha**. Le jalon M0 est terminé ; M1 et M2 sont en cours. Rien n'est prêt pour la production. Voir [ce qui marche aujourd'hui](#ce-qui-marche-aujourdhui) et la [roadmap](docs/ROADMAP.md) (en anglais).
>
> La version anglaise ([README.md](README.md)) fait foi ; la documentation détaillée (`docs/`) est en anglais.

**Mode d'emploi.** La [première partie](#partie-1--le-produit) s'adresse à qui doit juger si l'outil est utile : le problème, pour qui, une démo. La [seconde partie](#partie-2--sous-le-capot) s'adresse à qui le construit ou l'exploite : architecture, contrôle d'une lecture, mise en route.

| Partie 1 — Le produit | Partie 2 — Sous le capot |
|---|---|
| [Le problème](#le-problème) | [Architecture](#architecture) |
| [Un exemple](#un-exemple--un-endpoint-quatre-équipes) | [Scopes](#scopes) |
| [Ce qu'il garantit](#ce-quil-garantit) | [L'ontologie](#lontologie) |
| [Pour qui](#pour-qui) | [Anatomie d'une lecture](#anatomie-dune-lecture) |
| [Le voir tourner](#le-voir-tourner) | [Scopes dérivés](#scopes-dérivés) |
| [Demander et supprimer](#demander-et-supprimer) | [Interroger le graphe](#interroger-le-graphe) |
| [Ce qui le distingue](#ce-qui-le-distingue) | [Supprimer un nœud](#supprimer-un-nœud) |
| [Ce qui marche aujourd'hui](#ce-qui-marche-aujourdhui) | [Démarrage rapide](#démarrage-rapide) |
| | [Organisation du dépôt](#organisation-du-dépôt) |
| | [Contribuer](#contribuer) |

---

# Partie 1 — Le produit

## Le problème

Une grande organisation veut que ses agents IA sachent ce qu'elle sait. Aujourd'hui elle a deux options, mauvaises toutes les deux :

- **Tout ouvrir.** L'agent d'une équipe lit des dossiers RH, des incidents de sécurité, des notes de fusion-acquisition et des données clients qui ne la regardent pas.
- **Cloisonner chaque équipe.** Chacune a son silo, et tout ce qui traverse les équipes est perdu — précisément là où les agents seraient le plus utiles.

Graph-Warden est la troisième option : **un graphe partagé, avec un accès décidé à chaque lecture.**

Filtrer la réponse finale ne suffit pas. Dans un graphe, le chemin lui-même fait fuiter de l'information :

```mermaid
flowchart LR
    A["checkout<br/><i>team:front-a</i>"] -- CONSUMES --> O["GET /orders<br/><i>shared</i>"]
    P["Projet Falcon<br/><i>team:m-and-a</i>"] -. "chemin qu'un agent<br/>ne doit pas emprunter" .-> O
    P --> R["Contrat distributeur X<br/><i>team:m-and-a</i>"]

    classDef ok fill:#e7f5ea,stroke:#2f8a47,color:#123
    classDef hidden fill:#fbe9e9,stroke:#c0392b,color:#123,stroke-dasharray: 4 3
    class A,O ok
    class P,R hidden
```

Un agent qui travaille pour un développeur front peut aller de `checkout` à `GET /orders`. Il ne doit pas continuer jusqu'au `Projet Falcon`, ni même apprendre qu'il existe parce qu'un chemin passait par lui. Graph-Warden vérifie les droits **avant chaque pas**, pas sur le résultat final.

## Un exemple : un endpoint, quatre équipes

L'équipe BFF s'apprête à changer la pagination de `GET /orders`. Trois équipes front le consomment.

- **Bob** (équipe BFF) demande à son agent ce qui dépend de l'endpoint. Il voit son service et sa décision d'architecture, pas les notes internes des équipes front.
- **Alice** (équipe front A) voit son module de paiement et l'incident qu'il a causé le mois dernier, pas l'intérieur du BFF.
- **Lea** (lead) voit tout, plus une synthèse d'impact rédigée pour les leads à partir des documents des trois équipes.
- **Bob ne voit pas cette synthèse**, bien qu'elle ait été publiée comme « partagée » : elle est construite à partir de documents qu'il n'a pas le droit de lire, donc Graph-Warden la restreint automatiquement.
- **Le DPO** peut lister chaque lecture faite par n'importe quel agent, et quand. Bob ne le peut pas.

Un graphe, cinq personnes, cinq vues correctes — et personne n'a configuré de filtre pour aucune d'elles. La [démo](#le-voir-tourner) joue exactement ce scénario.

## Ce qu'il garantit

| Garantie | En clair |
|---|---|
| **Accès vérifié à chaque pas** | Un agent ne passe jamais par ce que son utilisateur n'a pas le droit de voir, donc rien ne se déduit à travers. |
| **Une synthèse hérite de ses sources** | Une synthèse construite à partir des documents de trois équipes n'est lisible que par qui peut lire les trois. |
| **Privé par défaut** | Un document sans scope reste privé à qui l'a ajouté. Partager est toujours une décision. |
| **Une seule porte** | Agents et outils n'atteignent le graphe que par l'API. Personne n'interroge la base directement. |
| **Chaque lecture est enregistrée** | Qui a demandé, avec quels groupes, quoi, et ce qui est revenu. Si l'enregistrement échoue, la lecture échoue. |
| **Les réponses restent dans vos droits** | Une réponse d'IA n'est écrite qu'à partir de ce que vous pouvez lire, et une réponse enregistrée n'est visible que par qui peut lire tout ce dont elle est tirée. |
| **La suppression suit les synthèses** | Supprimer un document supprime les synthèses construites uniquement à partir de lui, et ne fait que délier celles qui ont d'autres sources. Vous voyez la liste complète et tapez le nom avant que quoi que ce soit parte. |
| **Votre annuaire décide** | Utilisateurs et groupes viennent de votre fournisseur d'identité (Entra ID, Okta, Keycloak, Google Workspace…). Pas de seconde base d'utilisateurs à maintenir. |
| **Effacement d'une source entière** *(prévu)* | Effacer une source (RGPD, article 17) applique la même suppression à chaque document qu'elle a apporté. |

## Pour qui

- **Équipes sécurité : des agents qui ne fuient pas.** Les droits sont vérifiés à chaque pas d'une traversée, pas seulement sur le résultat.
- **Équipes de développement : l'impact inter-équipes avant le merge.** Quand l'équipe BFF change un endpoint, les équipes front qui le consomment sont prévenues dans la pull request, avant que ça casse en production *(prévu, M2)*.
- **Protection des données et audit : la conformité intégrée.** Chaque lecture faite par un agent au nom d'un utilisateur est enregistrée, et l'effacement atteindra tout ce qu'un LLM a dérivé de la source effacée.
- **Équipes infrastructure : il tient dans les contraintes d'un grand groupe.**
  - Auto-hébergé, sur GCP, Azure ou on-premise.
  - Les postes développeurs n'ouvrent aucun port entrant : ils tirent la partie du graphe que leur utilisateur peut voir.
  - Pas de tunnel, et SSE plutôt que WebSocket, donc les proxys d'entreprise laissent passer.
  - Apache-2.0, que les juristes acceptent là où ils bloquent souvent l'AGPL.
  - N'importe quel modèle, y compris un modèle local pour les sources sensibles.

## Le voir tourner

La démo est l'exemple ci-dessus, sur une boutique fictive. Son graphe :

```mermaid
flowchart LR
    OS["orders-service<br/><i>team:bff</i>"] -- EXPOSES --> O["orders-api<br/><i>shared</i>"]
    ADR["adr-0007-cursor-pagination<br/><i>team:bff</i>"] -- DECIDES --> O
    CK["checkout<br/><i>team:front-a</i>"] -- CONSUMES --> O
    BO["backoffice<br/><i>team:front-b</i>"] -- CONSUMES --> O
    MA["mobile-app<br/><i>team:front-c</i>"] -- CONSUMES --> O
    INC["incident-142<br/><i>team:front-a</i>"] -- CAUSES --> CK
    PI["pagination-impact<br/><i>teams:bff,front-a,front-b</i>"] -- DERIVED_FROM --> ADR & CK & BO
    LN["lea-notes<br/><i>private:lea</i>"] -- REFERENCES --> ADR

    classDef shared fill:#e7f5ea,stroke:#2f8a47,color:#123
    classDef bff fill:#e6f0fb,stroke:#2e6fb7,color:#123
    classDef front fill:#f1eafb,stroke:#7d4fc0,color:#123
    classDef derived fill:#fff4e0,stroke:#d68910,color:#123
    classDef private fill:#f2f2f2,stroke:#777,color:#123
    class O shared
    class OS,ADR bff
    class CK,BO,MA,INC front
    class PI derived
    class LN private
```

Trois équipes de plus, Shopping-Front, User et Data, partagent quatre contrats. La table BigQuery de Data les lit tous, endpoint des commandes compris :

```mermaid
flowchart LR
    US["user-service<br/><i>team:user</i>"] -- EXPOSES --> UP["user-profile-api<br/><i>shared</i>"] & CE["consent-events<br/><i>shared</i>"]
    A12["adr-0012-email-out-of-profile<br/><i>team:user</i>"] -- DECIDES --> UP
    PP["product-page<br/><i>team:shopping-front</i>"] -- CONSUMES --> UP & RA["recommendations-api<br/><i>shared</i>"]
    CA["cart<br/><i>team:shopping-front</i>"] -- CONSUMES --> UP & RA
    WT["web-tracking<br/><i>team:shopping-front</i>"] -- EXPOSES --> CS["clickstream-events<br/><i>shared</i>"]
    REL["release-2026-42<br/><i>team:shopping-front</i>"] -- MODIFIES --> WT
    REL -- CAUSES --> INC["incident-208<br/><i>team:data</i>"]
    C360["customer-360 (BigQuery)<br/><i>team:data</i>"] -- CONSUMES --> CS & CE & UP & O["orders-api<br/><i>shared</i>"]
    RS["recommendations-service<br/><i>team:data</i>"] -- EXPOSES --> RA
    RS -- CONSUMES --> C360
    CD["conversion-dashboard<br/><i>team:data</i>"] -- CONSUMES --> C360
    INC -- CAUSES --> CD
    A3["adr-0003-versioned-clickstream<br/><i>shared</i>"] -- DECIDES --> CS
    A3 -- FIXES --> INC
    PV["profile-v2-impact<br/><i>teams:data,shopping-front,user</i>"] -- DERIVED_FROM --> A12 & PP & C360
    ET["erasure-trail<br/><i>teams:data,user</i>"] -- DERIVED_FROM --> US & C360 & RS

    classDef shared fill:#e7f5ea,stroke:#2f8a47,color:#123
    classDef user fill:#e6f0fb,stroke:#2e6fb7,color:#123
    classDef front fill:#f1eafb,stroke:#7d4fc0,color:#123
    classDef data fill:#e8f6f8,stroke:#1f8a99,color:#123
    classDef derived fill:#fff4e0,stroke:#d68910,color:#123
    class UP,CE,RA,CS,O,A3 shared
    class US,A12 user
    class PP,CA,WT,REL front
    class C360,RS,CD,INC data
    class PV,ET derived
```

| Personne | Groupes (fournis par l'annuaire) |
|---|---|
| Bob | `dev`, `bff` |
| Alice | `dev`, `front-a` |
| Carla | `dev`, `front-c` |
| Lea | `dev`, `dev-leads`, et à travers lui tous les groupes d'équipe |
| Marie | `dev`, `shopping-front` |
| Yanis | `dev`, `user` |
| Sofia | `dev`, `data` |
| DPO | `auditors` |

Il ne faut que Docker :

```sh
docker compose --profile demo up -d --build --wait
examples/shop/demo.sh
```

**1. Même question, même graphe, quatre réponses.** Bob voit le côté BFF de l'endpoint, Alice son module et son incident, Carla seulement l'application mobile. Lea, lead, voit tout autour, y compris ses propres notes privées.

<p align="center"><img src="docs/assets/demo-1-views.svg" alt="Quatre utilisateurs lancent la même traversée de orders-api et obtiennent des résultats différents ; Lea voit aussi la table BigQuery de Data qui lit l'endpoint" width="765"></p>

**2. Une synthèse prend le scope de toutes ses sources.** Bob est dans `bff` mais ni dans `front-a` ni dans `front-b` : pour lui, la synthèse d'impact n'existe pas. Lea la lit, ainsi que ses sources.

<p align="center"><img src="docs/assets/demo-2-derived.svg" alt="L'ingestion restreint pagination-impact ; Bob n'obtient rien, Lea obtient la synthèse et ses sources" width="789"></p>

**3. Tirer dans un cache local.** Le poste d'Alice n'ouvre aucun port : il tire un cache SQLite qui ne contient que ce qu'elle peut voir, puis seulement les changements.

<p align="center"><img src="docs/assets/demo-3-pull.svg" alt="Alice tire huit nœuds et trois arêtes dans un cache local" width="814"></p>

**4. Un endpoint est un contrat entre équipes.** La release 2026.42 de la boutique web a renommé `add_to_cart` en `cart_add` ; le tunnel de conversion de Data a chuté de 31 % à ventes constantes (INC-208), et les deux équipes ont écrit l'ADR 0003, un contrat de clickstream versionné. Marie voit la release et l'ADR, Sofia l'incident et l'ADR, aucune le document de l'autre équipe. Lea voit toute la chaîne.

<p align="center"><img src="docs/assets/demo-4-contract.svg" alt="Marie voit la release et l'ADR du contrat, Sofia le tableau de bord de l'incident et l'ADR, Lea les trois" width="862"></p>

**5. Le profil v2, à travers trois équipes.** L'ADR 0012 retire `email` du profil utilisateur après une remarque d'audit RGPD. Il casse le pré-remplissage newsletter de la page produit et le rapprochement CRM de `customer_360`. La synthèse d'impact des leads dérive de documents User, Shopping-Front et Data : Yanis, qui a écrit l'ADR, n'est que dans `user` et ne l'obtient pas. `erasure-trail`, la réponse à « où un client effacé est-il encore ? », est restreinte de la même façon à `teams:data,user`.

<p align="center"><img src="docs/assets/demo-5-profile.svg" alt="Yanis n'obtient rien de la synthèse d'impact du profil v2 ; Lea obtient ses trois sources, chez User, Shopping-Front et Data" width="838"></p>

**6. Chaque lecture est enregistrée.** Bob n'a pas le droit de lire le journal d'audit, et sa tentative est elle-même enregistrée. Le DPO, si.

<p align="center"><img src="docs/assets/demo-6-audit.svg" alt="Bob se voit refuser le journal d'audit ; le DPO lit chaque entrée, y compris la tentative refusée de Bob" width="1050"></p>

L'API de démo utilise des jetons fixes (`examples/shop/users.yaml`) et n'écoute que sur localhost. Pour l'arrêter : `docker compose --profile demo down`.

## Demander et supprimer

**Posez une question, obtenez une réponse sourcée.** `gwarden ask "Comment change la pagination des commandes ?"` répond à partir des documents que vous pouvez lire, et les cite. Bob et Lea qui posent la même question obtiennent des réponses différentes, parce qu'ils ne lisent pas les mêmes choses. Avec `--save`, la réponse devient une page du graphe que d'autres peuvent retrouver — visible seulement par qui peut lire tout ce dont elle est tirée.

**Supprimer sans laisser d'orphelins, ni de dégâts collatéraux.** `gwarden delete adr-0007-cursor-pagination` montre ce qui part avant que quoi que ce soit parte ; ici, avec une synthèse écrite uniquement à partir de cette décision :

```text
Deleting adr-0007-cursor-pagination removes:
  Decision  adr-0007-cursor-pagination  [team:bff]
  Concept   adr-summary  [team:bff]  derived only from deleted nodes
and detaches, keeping these nodes, their other sources and their scope:
  pagination-impact -DERIVED_FROM-> adr-0007-cursor-pagination

Are you sure? It will delete 2 entries from adr-0007-cursor-pagination.
Type adr-0007-cursor-pagination to confirm:
```

Seuls les membres d'un groupe d'écrivains peuvent supprimer ou enregistrer des réponses, et seulement ce qu'ils peuvent lire. Si le graphe a changé entre l'aperçu et la confirmation, rien n'est supprimé.

## Dans le navigateur

L'API sert aussi une application web : chaque nœud comme une page (titre, scope, provenance, texte, ce dont il dérive et ce qui pointe vers lui), la recherche, le graphe lui-même, les questions, des pages wiki écrites dans le navigateur, et le passé : un dépôt tel qu'il était à un commit, et l'impact d'une pull request dessiné en sous-graphe mis en évidence (avec `GWARDEN_REPOSITORIES` pointant vers les clones du worker). Un nœud passé n'est montré qu'à qui peut le lire alors et maintenant. Elle montre ce que son utilisateur peut lire, rien d'autre, et se met à jour quand le graphe change. Dans la démo, ouvrez http://localhost:8080 et connectez-vous avec un jeton de `examples/shop/users.yaml`.

<p align="center"><img src="docs/assets/web-1-page.png" alt="La page de la synthèse d'impact des leads : scope teams:bff,front-a,front-b, sa provenance, son texte, et les trois documents dont elle dérive" width="900"></p>

Le même graphe, pour Lea (toutes les équipes) et pour Bob (BFF seulement) :

<p align="center">
  <img src="docs/assets/web-2-graph.png" alt="Le graphe de Lea : neuf nœuds, toutes équipes confondues" width="49%">
  <img src="docs/assets/web-3-graph-bob.png" alt="Le graphe de Bob : trois nœuds, l'endpoint, le service BFF et la décision" width="49%">
</p>

La connexion passe par votre fournisseur d'identité ; le navigateur ne détient jamais de jeton. Les pages wiki suivent les mêmes règles que le reste : seuls les rédacteurs les enregistrent, seulement dans un scope qu'ils lisent, et un enregistrement fait par-dessus une version plus récente d'un autre est refusé au lieu de l'écraser.

## Ce qui le distingue

Les bases de graphe ont déjà un contrôle d'accès par rôle, et les bibliothèques de mémoire d'agent cloisonnent déjà les souvenirs par utilisateur. Ce qu'elles laissent ouvert, c'est ce qui se passe entre l'agent et la connaissance :

- des chemins qui fuient à travers des nœuds que le lecteur ne devrait pas voir ;
- des synthèses écrites par un LLM plus visibles que leurs sources ;
- un effacement qui s'arrête au document d'origine ;
- des changements dans une équipe qui en cassent une autre sans prévenir.

## Ce qui marche aujourd'hui

- l'ontologie typée (Zod), étendue par configuration avec les types propres à l'organisation, et un stockage de graphe Neo4j ;
- l'ingestion de documents Markdown, JSON et YAML avec références typées, privés par défaut ;
- la traversée avec scopes vérifiés à chaque saut ; les documents dérivés lisibles seulement par qui lit toutes leurs sources ;
- une API REST dont identités et groupes viennent d'un fournisseur OIDC ou de Google avec Cloud Identity ;
- une entrée d'audit pour chaque lecture, question et suppression ;
- `gwarden pull` vers un cache SQLite local qui ne contient que ce que l'utilisateur peut voir ;
- `gwarden ask`, des réponses tirées des nœuds lisibles, par Claude (API Claude, Vertex AI, ou Google Cloud sans clé d'API) ou tout modèle compatible OpenAI, local compris, enregistrées comme nœuds dérivés sur demande ;
- `gwarden delete`, qui suit `DERIVED_FROM`, montré puis confirmé ;
- une application web : pages, recherche, graphe (Sigma.js), questions, suppression et pages wiki, à jour en direct via SSE ;
- une démo `docker compose` et un déploiement Cloud Run.

**Pas encore :** la revalidation des scopes dérivés quand une source ou un groupe change, l'effacement d'une source entière, MCP, la compilation par LLM, et le voyage dans le temps dans l'application web. La conception est arrêtée dans [`docs/proposals`](docs/proposals) ; le travail est suivi dans les [issues](https://github.com/Graph-Warden/graph-warden/issues).

---

# Partie 2 — Sous le capot

## Architecture

```mermaid
flowchart LR
    subgraph Sources
        S1[merge sur main]
        S2[GitHub Action]
        S3[polling git]
        S4[docs : md / json / yaml]
    end

    subgraph Service["Service Graph-Warden"]
        Q["File d'ingestion<br/>ordonnée, idempotente,<br/>un seul écrivain"]
        G[("Neo4j<br/>GraphStore")]
        API["API<br/>scope à chaque saut<br/>provenance · audit"]
        Q --> G
        G --> API
    end

    IdP["Fournisseur d'identité<br/>OIDC · Cloud Identity"]
    LLM["Fournisseur LLM<br/>Claude, compatible OpenAI,<br/>ou modèle local"]

    S1 & S2 & S3 & S4 --> Q
    Q -.-> LLM
    IdP -- "utilisateur + groupes" --> API

    API -- REST --> C1[vos outils]
    API -- MCP --> C2["Claude Code, Cursor,<br/>LibreChat, Open WebUI"]
    API -- SSE --> C3[application web]
    C4["CLI gwarden<br/>+ cache local"] -- pull --> API
```

Aujourd'hui : l'ingestion de documents par le CLI, Neo4j, l'API REST, les fournisseurs d'identité, `gwarden pull`, les réponses aux questions par Claude, et l'application web, en direct via SSE. Prévu : la file, la compilation par LLM, les webhooks et MCP.

- **Le graphe est la source de vérité**, jamais les fichiers dont il est construit. Il vit sur un serveur : Neo4j en local (`pnpm db:up`) ou un déploiement hébergé, d'où `gwarden pull` ne récupère que ce que l'utilisateur peut voir.
- **Un seul écrivain, ingestion ordonnée** *(conception)* : seul le merge sur `main` écrit les nœuds partagés, dans l'ordre des commits, et rejouer un webhook ne crée aucun doublon ([proposal 0004](docs/proposals/0004-single-writer-ordered-ingestion.md)).
- **Ingestion ciblée**, comme `jest --findRelatedTests` : un merge ne revalide que la connaissance atteignable depuis les fichiers modifiés ([proposal 0005](docs/proposals/0005-targeted-ingestion.md)).
- **Aucun port entrant sur les postes développeurs** : les clients tirent ou s'abonnent en SSE ([proposal 0006](docs/proposals/0006-pull-and-sse.md)).
- **Votre modèle, votre client** : une interface `LLMProvider`, n'importe quel client MCP ([proposal 0007](docs/proposals/0007-pluggable-llm-and-clients.md)).

## Scopes

Chaque nœud porte exactement un scope :

| Scope | Lisible par |
|---|---|
| `shared` | toute personne authentifiée |
| `team:bff` | les membres du groupe `bff` |
| `teams:bff,front-a` | les membres des **deux** groupes (typiquement un nœud dérivé des deux équipes) |
| `private:alice` | Alice seulement |

Les groupes viennent du fournisseur d'identité, groupes imbriqués résolus. La supervision se décide là-bas, pas dans Graph-Warden : un groupe `dev-leads` imbriqué dans chaque groupe d'équipe permet aux leads de lire à travers les équipes. Voir la [proposal 0002](docs/proposals/0002-one-graph-many-scopes.md) et la [proposal 0010](docs/proposals/0010-identity-groups-and-derived-scopes.md).

## L'ontologie

Les nœuds et les arêtes sont typés. Les types du cœur sont ceux sur lesquels le domaine s'appuie : `Module`, `Endpoint`, `Decision`, `Concept`, `Incident`, `Team`, `Person`, `Session`, `Source`, `Change` ; `IMPORTS`, `EXPOSES`, `CONSUMES`, `DECIDES`, `DERIVED_FROM`, `CAUSES`, `FIXES` et quelques autres. Une organisation ajoute les siens dans un fichier YAML désigné par `GWARDEN_ONTOLOGY`, lu par l'API et par `gwarden ingest` :

```yaml
nodeTypes: [Microservice, Dataset, Dashboard]
edgeTypes: [OWNS, RUNS_ON]
```

L'ontologie reste fermée : un nœud ou une arête d'un type qu'elle n'a pas est refusé à l'écriture, si bien qu'une faute de frappe ne devient jamais une nouvelle sorte de chose. On ajoute des types, on n'en retire jamais. Un type de nœud s'écrit en PascalCase, un type d'arête en UPPER_SNAKE_CASE ; le stockage Neo4j refuse aussi les noms de ses propres labels (`Node`, `AuditEntry`, `Event`, `Counter`). La démo déclare `Dataset` et `Dashboard` pour l'équipe Data ([`examples/shop/ontology.yaml`](examples/shop/ontology.yaml)) ; `GET /v1/ontology` liste les types en vigueur. Voir la [proposal 0001](docs/proposals/0001-typescript-and-zod.md).

## Anatomie d'une lecture

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Agent d'Alice
    participant API
    participant IdP as Fournisseur d'identité
    participant Reader as Reader (core)
    participant Store as GraphStore
    participant Audit as AuditLog

    Dev->>API: GET /v1/nodes/orders-api/neighbours<br/>Authorization: Bearer jeton
    API->>IdP: principalFor(jeton)
    IdP-->>API: alice, groupes [dev, front-a]
    API->>Reader: traverse(alice, orders-api)
    loop à chaque saut
        Reader->>Store: voisins de la frontière courante
        Store-->>Reader: nœuds candidats
        Reader->>Reader: écarte tout nœud qu'alice ne peut pas lire,<br/>et ne s'étend jamais depuis lui
    end
    Reader->>Audit: append(alice, groupes, départ, options, ids renvoyés)
    Audit-->>Reader: écrit (sinon la lecture échoue)
    Reader-->>API: nœuds visibles
    API-->>Dev: 200 { nodes }
```

L'API est le seul endroit où les lecteurs atteignent le graphe ([proposal 0003](docs/proposals/0003-api-as-sole-enforcement-point.md)). L'entrée d'audit est écrite **avant** que la réponse parte ; les entrées sont en ajout seul, numérotées dans l'ordre d'écriture, et stockées hors du graphe que parcourent les traversées. Un test par propriétés (fast-check) le vérifie sur des graphes aléatoires : une traversée ne renvoie que des nœuds lisibles, et son résultat est inchangé quand on retire tous les nœuds que le lecteur ne peut pas voir — un nœud caché ne peut donc fuiter ni par un id, ni par un compte, ni par un chemin.

## Scopes dérivés

```mermaid
flowchart BT
    ADR["adr-0007-cursor-pagination<br/><i>team:bff</i>"]
    CK["checkout<br/><i>team:front-a</i>"]
    BO["backoffice<br/><i>team:front-b</i>"]
    PI["pagination-impact<br/>déclaré : shared<br/>restreint à : <b>teams:bff,front-a,front-b</b>"]

    PI -- DERIVED_FROM --> ADR
    PI -- DERIVED_FROM --> CK
    PI -- DERIVED_FROM --> BO

    classDef derived fill:#fff4e0,stroke:#d68910,color:#123
    class PI derived
```

Un nœud avec des arêtes `DERIVED_FROM` prend le scope de toutes ses sources réunies, son scope déclaré comptant comme une source de plus : la dérivation ne l'élargit donc jamais.

- les sources `shared` n'ajoutent aucune restriction ;
- les sources d'équipe s'additionnent : `team:bff` + `team:front-a` donne `teams:bff,front-a` ;
- une seule source privée rend le résultat privé à son auteur.

L'auteur doit pouvoir lire chaque source : personne ne dérive de ce qu'il ne peut pas voir.

## Interroger le graphe

```mermaid
sequenceDiagram
    actor User as Bob
    participant Asker as Asker (core)
    participant Audit as AuditLog
    participant LLM as LLMProvider
    participant Writer

    User->>Asker: ask("Comment change la pagination ?", save?)
    Asker->>Asker: recherche : nœuds lisibles seulement<br/>(ancre + voisins, puis correspondance des mots)
    Asker->>Audit: append(question, chaque nœud transmis)
    Asker->>LLM: ces nœuds, rien d'autre
    LLM-->>Asker: réponse citant des [[ids]]
    opt --save, groupe d'écrivains
        Asker->>Writer: nœud réponse, DERIVED_FROM chaque nœud lu,<br/>scope = déclaré ∩ lecteurs de tous
    end
    Asker-->>User: réponse + nœuds lus
```

La recherche est faite par le domaine, pas par le modèle : on sait donc exactement sur quels nœuds une réponse a pu s'appuyer. Une réponse enregistrée dérive de **tous**, cités ou non : elle est privée à qui pose la question par défaut, et `--scope shared` est restreint aux lecteurs de toutes ses sources ([proposal 0011](docs/proposals/0011-ask-and-governed-deletion.md)). Le modèle est derrière le port `LLMProvider` ; il a deux adaptateurs : Claude (`GWARDEN_LLM=claude`, modèle par défaut `claude-opus-5-5`, identifiants pris dans l'environnement) et toute API compatible OpenAI (`GWARDEN_LLM=openai`, `GWARDEN_LLM_MODEL`, `GWARDEN_LLM_BASE_URL` pour Azure OpenAI, Mistral ou un Ollama, vLLM ou LM Studio local, `OPENAI_API_KEY` si le serveur en demande une).

## Supprimer un nœud

```mermaid
flowchart BT
    X["adr-0007<br/><b>supprimé</b>"]
    S["adr-summary<br/>seule source : adr-0007<br/><b>supprimé aussi</b>"]
    D["digest<br/>seule source : adr-summary<br/><b>supprimé aussi</b>"]
    I["pagination-impact<br/>sources : adr-0007, checkout<br/><b>gardé, arête détachée, scope inchangé</b>"]
    C["checkout"]
    M["orders-service<br/>IMPORTS adr-0007<br/><b>gardé</b>"]

    S -- DERIVED_FROM --> X
    D -- DERIVED_FROM --> S
    I -. "DERIVED_FROM (retirée)" .-> X
    I -- DERIVED_FROM --> C
    M -- IMPORTS --> X

    classDef gone fill:#fbe9e9,stroke:#c0392b,color:#123
    classDef kept fill:#e7f5ea,stroke:#2f8a47,color:#123
    class X,S,D gone
    class I,M,C kept
```

- Seul `DERIVED_FROM` se propage. Un nœud dont toutes les sources sont supprimées part aussi, en cascade ; un nœud qui a d'autres sources ne perd que l'arête.
- Un nœud qui perd une source **garde son scope** : son texte a aussi été écrit à partir de cette source, et l'élargir aux sources restantes le montrerait à des personnes qui n'ont jamais pu lire celle qui est supprimée.
- Supprimer exige un groupe d'écrivains (`GWARDEN_WRITERS`) et le droit de lire chaque nœud supprimé ou détaché ; sinon la suppression est refusée sans nommer ce qu'elle atteindrait.
- Le plan vient avec une empreinte. `DELETE /v1/nodes/{id}?confirm=<empreinte>` est refusé en 409 si le graphe a changé depuis : une confirmation ne couvre jamais plus que ce qui a été montré. Aperçus, suppressions et refus sont audités.

## Démarrage rapide

```sh
corepack enable
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

Les tests de l'adaptateur Neo4j tournent quand `NEO4J_TEST_URI` pointe vers une base jetable, qu'ils vident :

```sh
docker compose --profile test up -d --wait neo4j-test
NEO4J_TEST_URI=bolt://localhost:7688 pnpm test
```

### Ingérer et interroger en local

Ingérer un dossier de documents Markdown, JSON ou YAML dans le Neo4j local, puis parcourir le graphe sous différentes identités :

```sh
cp .env.example .env
pnpm db:up && pnpm build
pnpm gwarden ingest ~/docs --source docs:my-team --user alice --where theme=dev --default-scope team:dev
pnpm gwarden traverse some-page --user carol --team dev --direction both   # voit les pages de l'équipe
pnpm gwarden traverse some-page --user bob --direction both                # ne voit rien
pnpm gwarden audit --user carol                                            # ce que carol a lu, et quand

pnpm gwarden ingest ~/notes --source docs:alice --user alice       # aucun scope : privé à alice
```

Un document est une page Markdown avec frontmatter, ou un objet JSON ou YAML :

```markdown
---
type: Module
scope: team:front-a
references:
  - { type: CONSUMES, to: orders-api }
---
# Checkout

Liste les commandes du client avec `GET /orders`, page par page.
```

- `references` liste les arêtes, typées (`{ type: DECIDES, to: bff-api }`) ou non (`- glossary`, une arête `REFERENCES`, comme un lien Markdown `[[glossary]]`).
- `id` vaut par défaut le nom du fichier, `type` vaut `Concept`.
- `scope` (`shared`, `team:<x>`, `teams:<x>,<y>`, `private:<user>`) l'emporte sur `--default-scope`. Sans l'un ni l'autre, un document est privé à l'`--user` qui l'ingère.
- `--where clé=valeur` garde les documents dont le champ vaut la valeur ou, pour une liste, la contient.
- `--team` tient lieu des groupes que fournira un fournisseur d'identité. Via l'API, les groupes viennent du jeton.

Neo4j Browser sur <http://localhost:7474> (utilisateur `neo4j`, mot de passe dans `.env`) montre le graphe brut, par exemple `MATCH p=(:Node)-[:REFERENCES]->(:Node) RETURN p`. C'est une vue d'administrateur : elle contourne les scopes, que seuls `gwarden` et l'API appliquent.

### Via l'API

Les lecteurs passent par l'API, pas par Neo4j : `pnpm --filter @graph-warden/api start` avec les réglages de [`packages/api/src/config.ts`](packages/api/src/config.ts), puis `gwarden traverse`, `pull`, `cache` et `audit` avec `--api` et `--token` (ou `GWARDEN_API` et `GWARDEN_TOKEN`). L'API se documente elle-même sur `/openapi.json`.

| Route | Renvoie |
|---|---|
| `GET /v1/me` | l'utilisateur et les groupes de l'appelant |
| `GET /v1/nodes/{id}/neighbours` | les nœuds atteignables depuis `id` que l'appelant peut lire (`direction`, `depth`, `edge`) |
| `GET /v1/pull?after=<curseur>` | ce qui a changé pour l'appelant depuis le curseur |
| `GET /v1/audit` | le journal d'audit, pour les groupes auditeurs seulement |
| `GET /v1/nodes/{id}/deletion` | ce que supprimer `id` retirerait et détacherait, et l'empreinte pour le confirmer |
| `DELETE /v1/nodes/{id}?confirm=<empreinte>` | la suppression, pour les groupes d'écrivains, si le plan correspond toujours |
| `POST /v1/ask` | une réponse tirée des nœuds que l'appelant peut lire ; `save: true` l'enregistre (groupes d'écrivains) |

```sh
gwarden ask "Comment change la pagination des commandes ?" --from orders-api   # réponse, et nœuds lus
gwarden ask "Comment change la pagination des commandes ?" --save --scope shared
gwarden delete adr-0007-cursor-pagination                                     # montre, puis demande de taper l'id
```

Réglages de l'API pour les écritures : `GWARDEN_WRITERS` (groupes autorisés à supprimer et enregistrer des réponses), `GWARDEN_LLM` (`claude` ou `openai`), `GWARDEN_LLM_MODEL` et, pour `openai`, `GWARDEN_LLM_BASE_URL`.

### Déployer sur Google Cloud

[`deploy/gcp`](deploy/gcp/README.md) (en anglais) : l'API sur Cloud Run, le graphe sur Neo4j Aura, les identités via la connexion Google restreinte à votre domaine, les groupes via Cloud Identity.

## Organisation du dépôt

| Package | Rôle | État |
|---|---|---|
| `packages/core` | Ontologie, scopes, scopes dérivés, traversée vérifiée à chaque saut, lectures auditées, journal d'événements et deltas de pull, questions, plans de suppression ; ports `GraphStore`, `AuditLog`, `EventLog`, `IdentityProvider` et `LLMProvider` | M0 fait, M2 en cours |
| `packages/adapters/neo4j` | `GraphStore`, `AuditLog` et `EventLog` en ajout seul sur Neo4j | fait |
| `packages/adapters/identity` | `IdentityProvider` pour OIDC (Entra ID, Keycloak, Okta…), Google avec les groupes Cloud Identity, et jetons de démo | M2, première tranche |
| `packages/adapters/memory` | Ports en mémoire pour les tests et les démos | fait |
| `packages/adapters/documents` | Documents Markdown, JSON et YAML en nœuds et arêtes typées, avec leur texte | M1, première tranche |
| `packages/adapters/anthropic` | `LLMProvider` sur Claude | première tranche |
| `packages/adapters/openai` | `LLMProvider` sur toute API compatible OpenAI (OpenAI, Azure OpenAI, Mistral, Ollama, vLLM, LM Studio) | première tranche |
| `packages/cli` | `gwarden ingest`, `traverse`, `audit`, `pull`, `cache`, `ask`, `delete` ; plus tard `forget`, impact de PR | M0–M2 |
| `packages/api` | REST avec OpenAPI, seul point d'accès des lecteurs au graphe ; connexion des navigateurs, flux SSE, pages wiki ; webhooks plus tard | M2, première tranche |
| `packages/mcp` | Serveur MCP | M2, prévu |
| `packages/worker` | Consommateur de la file d'ingestion, appels LLM | M1, prévu |
| `packages/web` | Application web : pages, recherche, graphe (Sigma.js), questions, pages wiki, en direct via SSE ([proposal 0012](docs/proposals/0012-web-app-stream-and-wiki-pages.md)) | M2, première tranche |
| `packages/adapters/*` | Autres sources, fournisseurs LLM, stockages, files, analyseurs | M1+ |

```mermaid
flowchart TB
    cli[cli] --> core
    api[api] --> core
    cli --> documents[adapters/documents]
    cli --> neo4j[adapters/neo4j]
    api --> identity[adapters/identity]
    api --> neo4j
    api --> anthropic[adapters/anthropic]
    anthropic --> core
    documents --> core
    neo4j --> core
    identity --> core
    memory[adapters/memory] --> core
    web[web] -. HTTP .-> api
    core(["core<br/>domaine + ports, sans I/O"])
```

Le core porte les règles et définit les ports ; les adaptateurs les implémentent ([proposal 0009](docs/proposals/0009-domain-driven-design.md)). Un nouveau stockage, une nouvelle source ou un nouveau fournisseur d'identité est un adaptateur, jamais un changement des règles. Le vocabulaire est dans le [glossaire](docs/glossary.md) (en anglais).

## Contribuer

Les adaptateurs sont la porte d'entrée la plus simple : chaque type a une interface typée dans `core` (une suite de conformité partagée par type est prévue). Lisez [CONTRIBUTING.md](CONTRIBUTING.md), puis choisissez une issue étiquetée [`good first issue`](https://github.com/Graph-Warden/graph-warden/labels/good%20first%20issue). Les commits suivent Conventional Commits et sont signés (`git commit -s`).

Vous avez trouvé un moyen de lire ce que vous ne devriez pas ? Signalez-le en privé : voir [SECURITY.md](SECURITY.md).

## Licence

[Apache-2.0](LICENSE)
