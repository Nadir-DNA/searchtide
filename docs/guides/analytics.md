# Searchtide analytics (intégré)

**Temps estimé :** 0 min · **Toujours disponible** · **Rien à connecter.**

Searchtide analytics est le suivi de visites intégré, sans cookie. Il n'y a aucune clé à créer : il suffit d'ajouter un site et de coller le script.

## Ce que ça débloque

- Visites et pages vues
- Pages, canaux, référents, campagnes UTM
- Part du trafic venant des IA (ChatGPT, Perplexity, Gemini, Copilot, Claude…)
- Pays (si l'instance reçoit un en-tête de pays)
- Événements personnalisés
- Fraîcheur du suivi (dernier événement reçu)

## Étapes

1. Dans Searchtide : **Sites → Ajouter un site**, saisissez le domaine (par exemple `exemple.com`).
2. Copiez le script affiché et collez-le dans le `<head>` du site :

```html
<script defer src="https://votre-instance/script.js" data-site="exemple.com"></script>
```

3. Ouvrez une page du site, puis vérifiez que la visite apparaît dans Searchtide (quelques secondes).
4. Pour un événement : `searchtide("inscription")` en JavaScript, ou l'attribut `data-searchtide="clic-cta"` sur un élément.
5. Pays : placez l'instance derrière Cloudflare (gratuit) pour l'en-tête `cf-ipcountry`, ou Vercel (`x-vercel-ip-country`), ou envoyez `x-country`.

## Ce que vous voyez

- La carte « Searchtide analytics » est marquée **« Intégré »** : pas de bouton « Connecter », pas de test.
- Le site apparaît dans « Sites » avec ses visites dès le premier chargement du script.

## Problèmes fréquents

| Symptôme | Cause probable | Action |
|---|---|---|
| Aucune visite | Script absent du `<head>`, ou `data-site` ne correspond pas au domaine ajouté. | Vérifiez le script et la valeur `data-site`, puis rechargez la page. |
| Visites en double | Script présent deux fois (thème + plugin, par exemple). | Gardez une seule balise. |
| Pays toujours vide | Aucun en-tête de pays reçu. | Passez par Cloudflare, ou envoyez `x-country`. |
| Événement absent | Nom différent, ou script bloqué. | Utilisez exactement le même nom ; vérifiez la console du navigateur. |

## Limites et sécurité

- **Sans cookie** : aucune bannière de consentement n'est nécessaire. L'empreinte anonyme change chaque jour et ne permet pas de suivre une personne.
- Le script doit être servi par **votre instance** ; un domaine différent de `data-site` n'est pas compté.
- Un bloqueur de publicités peut empêcher le chargement : c'est un comportement attendu.
- Aucun chiffre n'est importé d'un outil tiers : cet analytics ne remplace pas Search Console.
- Pour arrêter le suivi d'un site : retirez le script, puis supprimez le site dans Searchtide.

## Liens de ce guide

Aucun lien externe : tout est servi par votre instance.
