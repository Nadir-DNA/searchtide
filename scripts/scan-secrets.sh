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

# 3. Fichiers sensibles suivis (jamais de contenu affiché)
bad=$(git ls-files | grep -E '(^|/)\.env$|(^|/)\.env\.(local|production|development)$|(^|/)google[^/]*\.json$|(^|/).*\.(pem|p12)$' || true)
if [ -n "$bad" ]; then printf '[MOTIF] fichiers sensibles suivis par Git\n'; printf '%s\n' "$bad" | sed 's/^/    /'; hits=$((hits+1));
else printf '[ok] aucun .env, google*.json, .pem ou .p12 suivi\n'; fi
verybad=$(git log --all --name-only --format= | grep -E '(^|/)(\.env|google[^/]*\.json)$' | sort -u || true)
if [ -n "$verybad" ]; then printf "[MOTIF] fichiers sensibles présents dans l'historique\n"; printf '%s\n' "$verybad" | sed 's/^/    /'; hits=$((hits+1));
else printf "[ok] .env et google*.json absents de l'historique\n"; fi

printf 'Motifs de clé en alerte : %d\n' "$hits"
exit $((hits > 0))
