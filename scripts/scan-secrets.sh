#!/usr/bin/env bash
# Scan de secrets : arbre de travail ET toutes les révisions (`git rev-list --all`).
# N'affiche jamais de valeur : seulement commit:chemin:ligne et le nom du motif.
# Usage : scripts/scan-secrets.sh [depot] ; code 0 = aucun motif de clé, 1 = au moins un.
set -u
repo=${1:-.}; cd "$repo" || exit 2
hits=0

tree_hits() { # motif ERE -> fichiers:lignes
  git ls-files -co --exclude-standard | xargs -d '\n' grep -nIE -e "$1" 2>/dev/null | cut -d: -f1,2 | sort -u
}

report_tree() { # nom, ERE
  local out; out=$(tree_hits "$2")
  if [ -n "$out" ]; then printf '[MOTIF] %s\n' "$1"; printf '%s\n' "$out" | sed 's/^/    /'; hits=$((hits+1));
  else printf '[ok] %s\n' "$1"; fi
}

# 1. Clés de fournisseurs (formats connus)
report_tree "clés Stripe (sk_/rk_/pk_/whsec_)" '(sk|rk|pk)_(live|test|org)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}'
report_tree "clés privées et jetons (PEM, AKIA, GitHub, Slack, Google)" 'BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}'
report_tree "URL de base avec identifiants (postgres/mysql/mongo/redis)" '(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp)://[^[:space:]/:@]+:[^[:space:]/@]+@'

# 2. Historique : mêmes motifs de clés, sur toutes les révisions (une clé supprimée reste dans les anciens commits)
hist=$(for c in $(git rev-list --all); do
  git grep -InE '(sk|rk|pk)_(live|test|org)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}' "$c" 2>/dev/null
done | sed -E 's/^([0-9a-f]{7})[0-9a-f]+:/\1:/' | sort -u)
if [ -n "$hist" ]; then printf "[MOTIF] clés de fournisseur dans l'historique (commit:fichier:ligne)\n"; printf '%s\n' "$hist" | sed 's/^/    /'; hits=$((hits+1));
else printf "[ok] clés de fournisseur absentes de toutes les révisions\n"; fi

brands=$(for c in $(git rev-list --all); do
  git grep -InE 'terme-local-1|terme-local-5|terme-local-4|terme-local-3|terme-local-7|terme-local-2|terme-local-6|terme-local-8' "$c" 2>/dev/null
done | sed -E 's/^([0-9a-f]{7})[0-9a-f]+:/\1:/' | grep -v ':scripts/scan-secrets.sh:' | sort -u)
if [ -n "$brands" ]; then printf "[MOTIF] marques de projets personnels dans l'historique (commit:fichier:ligne)\n"; printf '%s\n' "$brands" | sed 's/^/    /'; hits=$((hits+1));
else printf "[ok] marques de projets personnels absentes de l'historique\n"; fi

# 3. Marques et domaines de projets personnels (le nom de l'auteur dans LICENSE/README est attendu, pas ces marques)
brand_hits=$(tree_hits 'terme-local-1|terme-local-5|terme-local-4|terme-local-3|terme-local-7|terme-local-2|terme-local-6|terme-local-8' | grep -v '^scripts/scan-secrets.sh:' || true)
if [ -n "$brand_hits" ]; then printf '[MOTIF] marques et domaines de projets personnels\n'; printf '%s\n' "$brand_hits" | sed 's/^/    /'; hits=$((hits+1));
else printf "[ok] marques et domaines de projets personnels absents de l'arbre (nom de l'auteur attendu dans LICENSE/README)\n"; fi

# 4. Fichiers sensibles suivis (jamais de contenu affiché)
bad=$(git ls-files | grep -E '(^|/)\.env$|(^|/)\.env\.(local|production|development)$|(^|/)google[^/]*\.json$|(^|/).*\.(pem|p12)$' || true)
if [ -n "$bad" ]; then printf '[MOTIF] fichiers sensibles suivis par Git\n'; printf '%s\n' "$bad" | sed 's/^/    /'; hits=$((hits+1));
else printf '[ok] aucun .env, google*.json, .pem ou .p12 suivi\n'; fi
verybad=$(git log --all --name-only --format= | grep -E '(^|/)(\.env|google[^/]*\.json)$' | sort -u || true)
if [ -n "$verybad" ]; then printf "[MOTIF] fichiers sensibles présents dans l'historique\n"; printf '%s\n' "$verybad" | sed 's/^/    /'; hits=$((hits+1));
else printf "[ok] .env et google*.json absents de l'historique\n"; fi

# 5. Hygiène avant archive (T33) : présence seulement, aucun contenu lu
for f in .env google.json data .taste-skill; do
  if [ -e "$f" ]; then printf "[À TRAITER] %s présent sur le disque, hors Git : à déplacer/protéger avant toute archive (T33)\n" "$f"; fi
done

printf 'Motifs de clé en alerte : %d\n' "$hits"
exit $((hits > 0))
