// Filet de sécurité des vues chargées à la demande : un chunk introuvable (mise à jour avec un onglet
// ouvert, noms hachés changés, réseau coupé) affiche un message et un rechargement, pas une page blanche.
import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mt-6 rounded-2xl border border-border bg-surface p-5">
        <p className="text-sm text-ink">Impossible de charger cet écran.</p>
        <p className="mt-1 text-xs text-muted">La version de l'application a peut-être changé, ou la connexion a été coupée.</p>
        <button type="button" onClick={() => location.reload()} className="mt-3 rounded-full border border-control px-4 py-2 text-sm font-medium hover:bg-raised">Recharger</button>
      </div>
    );
  }
}
