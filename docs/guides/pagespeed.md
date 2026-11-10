# Connecter PageSpeed Insights

**Temps estimé :** ~1 min · **Un seul compte** · **Lecture seule.**

Searchtide mesure une page avec Google PageSpeed Insights, une fois par jour. La clé API est **facultative** : sans elle, Google applique un quota partagé.

## Ce que ça débloque

- Score de performance (0–100)
- Score SEO (0–100)
- LCP, en secondes (Largest Contentful Paint)
- CLS (Cumulative Layout Shift)

## Avant de commencer

- L'adresse **HTTPS** de la page à mesurer.
- Facultatif : un projet Google Cloud et une clé API pour disposer de votre propre quota.

## Étapes

1. **Sans clé** : allez directement à l'étape 4. Searchtide accepte une connexion PageSpeed sans clé.
2. **Avec clé** : dans Google Cloud, ouvrez les identifiants <https://console.cloud.google.com/apis/credentials> → « Créer des identifiants » → **« Clé API »**.
3. Si Google le demande, activez l'API **PageSpeed Insights** dans le même projet. Collez la clé dans le champ « Clé API ».
4. Dans Searchtide : **Connexions → PageSpeed → Connecter**, puis **« Tester et enregistrer »**.
5. Sur un projet : **Sources → Rattacher → PageSpeed**, saisissez l'**adresse de la page** et choisissez **Mobile** ou **Ordinateur**. Les quatre mesures sont proposées.

## Ce que vous voyez après le test

- **Avec clé :** « Connecté : PageSpeed (clé API) », puis « Clé acceptée par Google. »
- **Sans clé :** « Connecté : PageSpeed (sans clé) », avec l'avertissement « Sans clé, Google peut limiter les relevés (quota partagé) : ajoutez une clé API si cela arrive. »
- Le test s'arrête au bout de 6 s : une mesure Lighthouse complète dure souvent plus longtemps. Une absence d'erreur de clé à cet instant vaut acceptation.

## Erreurs fréquentes

| Message affiché | Cause | Action |
|---|---|---|
| « PageSpeed refuse cette clé : vérifiez qu'elle est complète et active. » | Clé fausse, supprimée, ou restreinte à un autre usage. | Recréez une clé API, ou laissez le champ vide. |
| « Permission manquante : activez l'API PageSpeed Insights dans le projet Google Cloud de cette clé. » | L'API n'est pas activée pour ce projet. | Activez-la, attendez une minute, retestez. |
| « Quota PageSpeed dépassé : réessayez plus tard, ou ajoutez une clé API (connexion PageSpeed). » | Trop de relevés sans clé (quota partagé). | Ajoutez une clé API, ou attendez le renouvellement du quota. |
| « Adresse de page invalide (https://…). » | URL sans schéma, ou non HTTP(S). | Utilisez une adresse complète en `https://`. |
| « PageSpeed n'a pas renvoyé de résultat pour cette page. » | Page inaccessible, bloquée, ou mesure interrompue. | Vérifiez que la page répond publiquement, puis retestez. |
| « PageSpeed ne répond pas. Réessayez dans un instant. » | Délai de 10 s dépassé au test. | Réessayez ; la mesure réelle peut prendre plus longtemps. |

## Limites et sécurité

- **Une seule connexion PageSpeed**, mais plusieurs indicateurs possibles (une URL par indicateur, mobile ou ordinateur).
- Mesure **par page**, pas par site : pour trois pages, créez trois indicateurs.
- La clé API est facultative ; sans elle, le quota est partagé et peut se bloquer.
- Aucune écriture chez Google : l'API ne fait que mesurer une URL publique.
- Une mesure réelle peut durer jusqu'à 120 s côté Searchtide ; elle ne bloque pas les autres relevés.
- Pour retirer : « Retirer » dans la carte, puis supprimez la clé API dans Google Cloud si elle ne sert plus.

## Liens de ce guide (vérifiés le 10/11/2026)

| Lien | Code observé | Remarque |
|---|---|---|
| <https://console.cloud.google.com/apis/credentials> | 302 → `accounts.google.com` | Normal hors session : connexion Google demandée. |
| <https://www.googleapis.com/pagespeedonline/v5/runPagespeed> | 429 | Appel sans paramètres ni clé : quota/validation côté Google. Ce n'est pas un lien à ouvrir. |
