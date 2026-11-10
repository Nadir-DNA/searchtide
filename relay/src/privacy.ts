// Texte servi par GET /privacy, repris de 04-politique-confidentialite-relais.md. Les [À compléter] bloquent le mode production.
export const PRIVACY_FR = `**Searchtide Connect** est un petit service qui permet à votre instance Searchtide de lire vos données Stripe après que vous avez cliqué sur « Connexion avec Stripe ». Il est optionnel : vous pouvez toujours connecter Stripe avec une clé restreinte \`rk_\`, sans aucun échange avec ce service.

### Qui est responsable
Le service est exploité par **Nadir DAOUDI**, pays : **France**. Contact : via GitHub, par un **signalement privé** (onglet Security → Report a vulnerability) ou une issue du dépôt **https://github.com/Nadir-DNA/searchtide**. Aucune adresse e-mail n'est publiée.

### Ce que le service fait
1. Il vous redirige vers Stripe pour que vous autorisiez Searchtide Connect sur votre compte.
2. Il garde un lien entre **votre instance** et **votre compte Stripe**, sous la forme d'un jeton que seule votre instance connaît.
3. Quand votre instance demande vos chiffres (solde, transactions, abonnements, nouveaux clients), il interroge Stripe **en lecture seule** à sa place et lui renvoie la réponse.

### Ce qui traverse le service sans être conservé
Pour répondre, le service **voit** les données Stripe demandées : montants, devises, dates, statuts d'abonnement, identifiants techniques. Il ne renvoie **ni nom, ni adresse e-mail, ni adresse postale** de vos clients (champs retirés avant la réponse). Il **ne conserve aucune réponse de Stripe** : rien n'est mis en cache ni écrit en base.

Vos clients sont les vôtres : vous restez responsable de leurs données. Le service n'agit que comme intermédiaire technique, sur votre instruction.

### Ce qui est conservé
| Donnée | Pourquoi | Durée |
|---|---|---|
| Identifiant de votre compte Stripe (\`acct_…\`) | relier votre instance à votre compte | jusqu'à la révocation, ou 180 jours sans aucun usage |
| Empreinte (hash) du jeton de l'instance, adresse de l'instance (nom d'hôte) et identifiant aléatoire | authentifier les demandes ; vous montrer, avant Stripe, qui demande l'accès | jusqu'à la révocation, ou 180 jours sans usage |
| Dates de création et de dernier usage, compteur quotidien de demandes | limiter les abus | idem |
| Journal technique : date, route, code de réponse, identifiant d'instance (jamais de paramètre, de montant ni de donnée Stripe) | sécurité et diagnostic | **7 jours** |
| États d'autorisation et codes à usage unique | sécuriser le retour de Stripe | 10 minutes et 60 secondes, puis purge |

Le service **n'enregistre pas votre adresse IP**. L'hébergeur, Cloudflare, traite des données de connexion pour acheminer les requêtes, selon sa propre politique.

### Ce que le service ne fait pas
Aucune vente ni cession de données, aucune publicité, aucun outil de mesure d'audience, aucun cookie, aucune écriture sur votre compte Stripe.

### À propos de « lecture et écriture » sur l'écran de Stripe
Stripe n'offre pas, pour ce type de connexion, d'autorisation « lecture seule » : son écran indiquera « lecture et écriture ». Searchtide Connect n'émet que des **requêtes de lecture** : le code du service est **public** (https://github.com/Nadir-DNA/searchtide/tree/main/relay) et refuse toute autre méthode. Cette garantie repose sur ce code, pas sur Stripe.

### Révoquer, supprimer
- **Depuis votre instance :** « Révoquer » supprime immédiatement le jeton et l'identifiant de compte du service.
- **Depuis Stripe :** retirer l'application dans votre Dashboard (Paramètres → Applications connectées) produit le même effet, à réception de la notification de Stripe.
- **Autres demandes** (accès, effacement) : par le contact GitHub ci-dessus ; réponse au mieux, sans engagement de délai.

### Sécurité
Échanges en HTTPS ; clés de la plateforme stockées comme secrets du Worker, jamais dans le dépôt ni dans les journaux ; jetons stockés sous forme de hash ; liste blanche stricte des lectures autorisées ; limites de débit par instance.

### Sous-traitants
**Stripe** (autorisation et données de paiement) et **Cloudflare** (hébergement du service).

### Changements
Ce texte peut évoluer ; la date de dernière mise à jour figure ci-dessous. Une modification qui élargit les données traitées sera annoncée dans les notes de version, et exigera un nouveau consentement.

Dernière mise à jour : **[À compléter : date de mise en ligne]**.

---`;

export const PRIVACY_EN = `**Searchtide Connect** is a small service that lets your Searchtide instance read your Stripe data after you click "Connect with Stripe". It is optional: you can always connect Stripe with a restricted \`rk_\` key, with no exchange with this service.

**Operator.** Nadir DAOUDI, country: **France**. Contact through GitHub: a private report (Security → Report a vulnerability) or an issue on **https://github.com/Nadir-DNA/searchtide**. No email address is published.

**What it does.** It redirects you to Stripe to authorise Searchtide Connect; it keeps a link between your instance and your Stripe account as a token only your instance knows; when your instance asks for your figures (balance, transactions, subscriptions, new customers), it queries Stripe **read-only** on its behalf and returns the answer.

**What passes through without being stored.** The service sees the requested Stripe data (amounts, currencies, dates, subscription statuses, technical ids). It returns **no names, email addresses or postal addresses** of your customers, and stores **no Stripe response**. Your customers remain yours: you stay responsible for their data; the service is only a technical intermediary acting on your instruction.

**What is stored.** Your Stripe account id (\`acct_…\`), a hash of the instance token, the instance host name and a random id, creation and last-use dates, and a daily request counter: until revocation, or 180 days without use. A technical log (date, route, status code, instance id; never parameters, amounts or Stripe data): **7 days**. Authorisation states and one-time codes: 10 minutes and 60 seconds, then purged. The service does **not** record your IP address; the host, Cloudflare, processes connection data under its own policy.

**What it does not do.** No sale or transfer of data, no advertising, no analytics, no cookies, no writes to your Stripe account.

**"Read and write" on Stripe's screen.** Stripe offers no read-only authorisation for this kind of connection, so its screen will say "read and write". Searchtide Connect only sends **read requests**: its code is **public** (https://github.com/Nadir-DNA/searchtide/tree/main/relay) and refuses any other method. This guarantee rests on that code, not on Stripe.

**Revoke, delete.** "Revoke" in your instance deletes the token and account id immediately; removing the app in your Stripe Dashboard has the same effect once Stripe's notification arrives. Other requests (access, erasure): through the GitHub contact, best effort, no committed deadline.

**Security.** HTTPS; platform keys kept as Worker secrets, never in the repository or logs; tokens stored as hashes; strict allow-list of reads; per-instance rate limits.

**Sub-processors.** Stripe and Cloudflare.

**Changes.** A change that widens the data processed will be announced in release notes and will require new consent. Last updated: **[To complete: date]**.`;
