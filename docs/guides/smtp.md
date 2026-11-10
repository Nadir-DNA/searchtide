# Connecter l'e-mail (SMTP)

**Temps estimé :** ~5 min · **Un seul compte** · **Envoi uniquement.**

Searchtide utilise votre serveur SMTP pour envoyer le rapport hebdomadaire, les alertes et les messages de prospection. Il ne lit **aucune** boîte mail.

## Ce que ça débloque

- Rapport hebdomadaire par e-mail
- Alertes par e-mail (site hors ligne, relevé en erreur, forte baisse, nouvelle vente)
- Envois de prospection

## Avant de commencer

- Une adresse e-mail d'envoi et, si le fournisseur l'exige, un **mot de passe d'application**.
- Pour Gmail : la **validation en 2 étapes** doit être active. Un mot de passe ordinaire est refusé par Google pour ce type d'usage.
- Le port SMTP autorisé par votre hébergeur : 465 (SSL) ou 587 (STARTTLS).

## Étapes

1. Choisissez le fournisseur : **Gmail** (serveur `smtp.gmail.com`, port 465, SSL, rempli automatiquement) ou **Autre serveur SMTP**.
2. **Gmail** : activez la validation en 2 étapes, puis créez un **mot de passe d'application** : <https://support.google.com/accounts/answer/185833>. Copiez les 16 caractères **sans espaces**.
3. Renseignez l'**identifiant** (votre adresse complète) et le **mot de passe** (le mot de passe d'application pour Gmail).
4. Facultatif : **Expéditeur** (par défaut l'identifiant) et **Destinataire du rapport** (par défaut l'identifiant).
5. **« Tester et enregistrer »** : un e-mail d'essai est réellement envoyé au destinataire indiqué.

## Ce que vous voyez après le test

- **Réussite :** « Connecté : {identifiant} », puis « E-mail d'essai envoyé à {destinataire} ». Vérifiez la boîte de réception (et les indésirables).
- L'e-mail d'essai a pour objet « Searchtide : e-mail d'essai » et peut être supprimé.

## Erreurs fréquentes

| Message affiché | Cause | Action |
|---|---|---|
| « Identifiant ou mot de passe refusé. Avec Gmail, utilisez un mot de passe d'application, pas votre mot de passe. » | Mot de passe ordinaire, mot de passe d'application révoqué, 2FA absente. | Activez la 2FA, créez un nouveau mot de passe d'application, collez-le sans espaces. |
| « Le serveur SMTP ne répond pas. Réessayez dans un instant. » | Délai de 10 s, port bloqué, hébergeur qui filtre le SMTP. | Vérifiez le port et le pare-feu ; essayez 465/SSL puis 587/STARTTLS. |
| « Connexion impossible à {hôte}:{port} : vérifiez l'hôte, le port et le type de sécurité. » | Hôte faux, port fermé, SSL attendu sur un port STARTTLS. | Corrigez l'hôte et le couple port/sécurité. |
| « Indiquez le serveur SMTP (ou choisissez Gmail). » | Préréglage « Autre » sans hôte. | Renseignez l'hôte, ou repassez sur Gmail. |
| « Le destinataire doit être une adresse e-mail. » | Destinataire vide ou sans `@`. | Saisissez une adresse complète. |
| « Cette clé est déjà enregistrée sous « {libellé} ». » | Un compte SMTP est déjà enregistré. | Un seul compte SMTP est permis : modifiez l'existant. |

## Limites et sécurité

- **Un seul compte SMTP** pour toute l'instance. Pour changer de compte, utilisez « Remplacer la clé » sur la connexion existante.
- Le connecteur **envoie** des messages (fonction assumée) : rien d'autre n'est modifié chez le fournisseur.
- Aucune lecture de boîte : les taux de réponse Gmail ne sont pas mesurés (prévu plus tard).
- Le mot de passe est chiffré et jamais réaffiché ; l'indice affiché est `identifiant · hôte`.
- Un e-mail d'essai part à chaque test : prévenez le destinataire si ce n'est pas vous.
- Pour retirer : « Retirer » dans la carte, puis révoquez le mot de passe d'application chez Google.

## Liens de ce guide (vérifiés le 10/11/2026)

| Lien | Code observé | Remarque |
|---|---|---|
| <https://support.google.com/accounts/answer/185833> | 200 | Aide Google « mots de passe d'application ». |
