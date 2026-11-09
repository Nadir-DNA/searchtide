// Connexions aux services : l'utilisateur autorise chez le fournisseur, aucun secret ne transite
// par l'interface. Chaque service affiche son état réel et une seule action possible.
import { useEffect, useState } from "react";
import { api } from "./api";
import { Card } from "./ui";

type Conn = { id: string; kind: string; label: string; account: string; scope: string | null; livemode: number; created_at: number };
type State = { stripe: { ready: boolean; callback: string | null }; list: Conn[] };

export function ConnectionsView() {
  // Résultat laissé par le retour d'autorisation dans l'adresse
  const params = new URLSearchParams(location.search);
  const result = params.get("connexion");
  const reason = params.get("raison");
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api<State>("/api/connections").then(setState).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, []);

  async function connectStripe() {
    setBusy(true); setError("");
    try {
      const { url } = await api<{ url: string }>("/api/connections/stripe/start");
      location.href = url; // autorisation chez Stripe, puis retour sur /api/connections/stripe/callback
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function disconnect(id: string) {
    await api(`/api/connections/${id}`, { method: "DELETE" });
    await load();
  }

  const stripe = state?.list.filter((c) => c.kind === "stripe") ?? [];

  return (
    <>
      <header className="pt-4 pb-6 md:min-h-20 md:pt-6">
        <h1 className="text-2xl leading-9 font-light md:text-[30px] md:leading-10">Connexions</h1>
        <p className="mt-1 text-sm text-muted">Autorisez un service ici : il n'y a aucune clé à coller.</p>
      </header>

      {error && <p role="alert" className="mb-4 text-sm text-negative">{error}</p>}
      {result === "ok" && <p role="status" className="mb-4 text-sm text-positive">Compte connecté.</p>}
      {result === "erreur" && <p role="alert" className="mb-4 text-sm text-negative">Connexion refusée : {reason || "autorisation annulée"}</p>}

      <div className="grid gap-5 lg:max-w-3xl">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-light">Stripe</h2>
              <p className="mt-1 max-w-md text-sm text-muted">
                Chiffre d'affaires, abonnements et nouveaux clients, en lecture seule. Aucun mouvement d'argent n'est possible.
              </p>
            </div>
            {state?.stripe.ready ? (
              <button type="button" onClick={connectStripe} disabled={busy}
                className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-[var(--color-accent-ink)] disabled:opacity-60">
                {busy ? "Ouverture de Stripe…" : stripe.length ? "Connecter un autre compte" : "Connecter Stripe"}
              </button>
            ) : (
              <span className="rounded-xl bg-raised px-3 py-2 text-xs text-muted">Non configuré sur cette instance</span>
            )}
          </div>

          {!state?.stripe.ready && (
            <p className="mt-3 text-xs leading-5 text-muted">
              L'administrateur doit renseigner <code className="font-mono">STRIPE_CLIENT_ID</code>,{" "}
              <code className="font-mono">STRIPE_OAUTH_SECRET_KEY</code> et <code className="font-mono">PUBLIC_URL</code>.
              L'autorisation exige une adresse publique en HTTPS.
            </p>
          )}

          {stripe.length > 0 && (
            <ul className="mt-4 divide-y divide-rule border-t border-rule">
              {stripe.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm">{c.label}</p>
                    <p className="font-mono text-xs text-muted">
                      {c.account} · {c.scope ?? "read_only"} · {c.livemode ? "production" : "test"}
                    </p>
                  </div>
                  <button type="button" onClick={() => disconnect(c.id)} className="text-sm text-muted hover:text-negative">
                    Retirer
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <p className="text-sm text-muted">
            Google Search Console, Cloudflare et les autres services arrivent ici. En attendant, leurs clés se
            renseignent dans le fichier <code className="font-mono">.env</code>.
          </p>
        </Card>
      </div>
    </>
  );
}
