// Texte servi par GET /terms (conditions d'utilisation du relais Searchtide Connect).
// Requis par l'écran de consentement OAuth de Google : l'URL doit être publique et sur le domaine autorisé.
export const TERMS_FR = `**Searchtide Connect** est un service gratuit et facultatif qui relie une instance Searchtide à vos comptes Stripe et Google Agenda. Son code est public : https://github.com/Nadir-DNA/searchtide/tree/main/relay.

### Qui l'exploite
**Nadir DAOUDI**, pays : **France**. Contact : via GitHub, par un **signalement privé** (onglet Security → Report a vulnerability) ou une issue du dépôt **https://github.com/Nadir-DNA/searchtide**. Aucune adresse e-mail n'est publiée.

### Conditions d'utilisation
1. Le service s'utilise uniquement depuis une instance Searchtide que vous administrez, et uniquement pour vos propres comptes.
2. Vous restez responsable de l'usage que votre instance fait de vos données, et du respect des conditions d'utilisation de Stripe et de Google.
3. Le service ne peut pas servir à un usage illicite, à l'envoi de messages non sollicités, ni à contourner les limites ou les contrôles d'un tiers.
4. Vous pouvez révoquer une connexion à tout moment (voir la politique de confidentialité). Le service peut être interrompu ou modifié sans préavis ; l'instance Searchtide reste utilisable seule pour tout ce qui ne dépend pas du relais.
5. Le secret de l'application Google reste sur le relais : il n'est transmis à aucune instance, et une instance ne peut l'utiliser qu'auprès de ce relais.

### Garanties et responsabilité
Le service est fourni « tel quel », sans garantie de disponibilité ni d'absence d'erreur. Sa responsabilité est limitée au maximum au montant que vous avez payé pour l'utiliser, soit zéro euro : un service gratuit ne peut pas être tenu responsable d'un manque à gagner, d'une perte de données ou d'une perte de rendez-vous. Aucune de ces conditions ne limite les responsabilités qui ne peuvent pas être limitées par la loi.

### Propriété intellectuelle
Le code de Searchtide et de Searchtide Connect est sous licence MIT (https://github.com/Nadir-DNA/searchtide/blob/main/LICENSE). Les marques et services de tiers (Stripe, Google) appartiennent à leurs titulaires.

### Droit applicable
Droit français. À défaut d'accord amiable, les tribunaux français sont compétents.

Dernière mise à jour : **13 novembre 2026**.`;

export const TERMS_EN = `**Searchtide Connect** is a free, optional service that links a Searchtide instance to your Stripe and Google Calendar accounts. Its code is public: https://github.com/Nadir-DNA/searchtide/tree/main/relay.

**Operator.** Nadir DAOUDI, country: **France**. Contact through GitHub: a private report (Security → Report a vulnerability) or an issue on **https://github.com/Nadir-DNA/searchtide**. No email address is published.

**Terms of use.** 1. The service may only be used from a Searchtide instance you administer, and only for your own accounts. 2. You stay responsible for what your instance does with your data, and for complying with Stripe's and Google's terms of use. 3. The service may not be used for unlawful activity, unsolicited messaging, or to bypass a third party's limits or safeguards. 4. You can revoke a connection at any time (see the privacy policy). The service may be interrupted or changed without notice; a Searchtide instance remains usable on its own for everything that does not depend on the relay. 5. The relay's Google application secret stays on the relay: it is never passed to any instance, and an instance can only use it through this relay.

**Warranties and liability.** The service is provided "as is", without any warranty of availability or freedom from error. Its liability is capped at the amount you paid for it, which is zero: a free service cannot be held liable for lost revenue, lost data or lost appointments. Nothing here limits liabilities that cannot be limited by law.

**Intellectual property.** The code of Searchtide and Searchtide Connect is MIT-licensed (https://github.com/Nadir-DNA/searchtide/blob/main/LICENSE). Third-party names and services (Stripe, Google) belong to their owners.

**Governing law.** French law. Failing an amicable agreement, the French courts have jurisdiction.

Last updated: **13 November 2026**.`;
