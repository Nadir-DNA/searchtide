// Module Analytics : trafic d'un site et installation du script de suivi.
import { useEffect, useState, type ReactNode } from "react";
import { api, type Search, type Site, type Traffic } from "../../api";
import { BarChart, Donut, fillDays } from "../../chart";
import { ErrorLine, KpiSkeleton, useData } from "../../App";
import { ActivateLink } from "../ActivatePrompt";
import { Button, Card, Delta, EmptyBox, KpiCard, Segmented, ShareList, Skeleton, Table, fmt, inputCls } from "../../ui";
export type Me = { gsc: boolean; demo: boolean };

export const CHANNELS: Record<string, string> = {
  direct: "Accès direct", search: "Moteurs de recherche", social: "Réseaux sociaux", ai: "Assistants IA",
  referral: "Autres sites", email: "Email", paid: "Publicité",
};

export const regionNames = new Intl.DisplayNames(["fr"], { type: "region" });

export const countryName = (code: string) => { try { return regionNames.of(code) ?? code; } catch { return code; } };

export function TrafficView({ site, days, onSetup }: { site: Site; days: number; onSetup: () => void }) {
  const { data: t, error, reload } = useData<Traffic>(`/api/sites/${site.id}/traffic?days=${days}`);
  const [metric, setMetric] = useState<"visitors" | "pageviews">("visitors");
  const [tech, setTech] = useState<"devices" | "browsers">("devices");
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!t) return <KpiSkeleton />;
  if (!t.totals.pageviews && !t.previous.pageviews) {
    return (
      <EmptyBox>
        Aucune visite sur cette période. Si vous venez d'ajouter le site, collez le script de suivi puis ouvrez une page du site.{" "}
        <button onClick={onSetup} className="text-ink underline">Voir le script</button>
      </EmptyBox>
    );
  }
  const chart = fillDays(t.daily, t.range.from, t.range.to, (d) => d[metric]);
  const metricName = metric === "visitors" ? "Visiteurs par jour" : "Pages vues";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Visites" hint="Visiteurs uniques de chaque jour, additionnés" value={fmt(t.totals.visitors)} delta={<Delta now={t.totals.visitors} before={t.previous.visitors} />} active={metric === "visitors"} onClick={() => setMetric("visitors")} />
        <KpiCard label="Pages vues" value={fmt(t.totals.pageviews)} delta={<Delta now={t.totals.pageviews} before={t.previous.pageviews} />} active={metric === "pageviews"} onClick={() => setMetric("pageviews")} />
        <KpiCard label="Pages par visiteur" value={t.totals.visitors ? fmt(t.totals.pageviews / t.totals.visitors, 1) : "—"} />
        <KpiCard label="Venus d'assistants IA" value={fmt(t.totals.ai)} delta={<Delta now={t.totals.ai} before={t.previous.ai} />}
          hint={t.totals.visitors ? `${fmt((t.totals.ai / t.totals.visitors) * 100)} % des visiteurs` : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title={metricName} action={
          <Segmented label="Série" value={metric} onChange={setMetric} options={[["visitors", "Visiteurs"], ["pageviews", "Pages vues"]] as const} />
        }>
          <BarChart label={metricName} days={chart.days} values={chart.values} />
        </Card>
        <Card title="Provenance">
          <Donut total={t.totals.visitors} totalLabel="visiteurs" parts={t.channels.map((c) => ({ label: CHANNELS[c.key] ?? c.key, value: c.visitors }))} />
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Pages"><ShareList label="Page" rows={t.pages} empty="Aucune page vue sur cette période." /></Card>
        <Card title="Sites référents"><ShareList label="Site" rows={t.referrers} empty="Aucun lien depuis un autre site sur cette période." /></Card>
        <Card title="Assistants IA"><ShareList label="Assistant" rows={t.aiReferrers} empty="Personne n'est arrivé depuis ChatGPT, Perplexity, Claude ou Gemini sur cette période." /></Card>
        <Card title="Pays"><ShareList label="Pays" rows={t.countries} map={countryName} empty="Pays inconnus : placez l'instance derrière Cloudflare pour les obtenir." /></Card>
        <Card title="Appareils" action={<Segmented label="Détail" value={tech} onChange={setTech} options={[["devices", "Type"], ["browsers", "Navigateur"]] as const} />}>
          <ShareList label={tech === "devices" ? "Appareil" : "Navigateur"} rows={t[tech]} empty="Aucune donnée." />
        </Card>
        <Card title="Campagnes"><ShareList label="utm_campaign" rows={t.campaigns} empty="Aucune visite avec un paramètre utm_campaign sur cette période." /></Card>
      </div>
    </div>
  );
}

export function SettingCard({ title, sub, children }: { title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-10">
        <div><h2 className="text-lg font-light">{title}</h2><p className="mt-1 text-sm text-muted">{sub}</p></div>
        <div className="min-w-0">{children}</div>
      </div>
    </Card>
  );
}

export function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-border bg-raised px-3 py-2.5 font-mono text-xs leading-5"><code>{text}</code></pre>
      <Button variant="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
        {done ? "Copié" : "Copier"}
      </Button>
    </div>
  );
}

export function SetupView({ site, me, onChange, go }: { site: Site; me: Me; onChange: () => void; go: (n: Record<string, string | undefined>) => void }) {
  const [props, setProps] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (me.gsc && !me.demo) api<string[]>("/api/gsc/properties").then(setProps).catch((e) => setError(e.message)); }, [me]);
  async function link(gsc_property: string) {
    await api(`/api/sites/${site.id}`, { method: "PATCH", json: { gsc_property } });
    onChange();
  }
  async function remove() {
    if (!confirm(`Supprimer ${site.domain} et toutes ses statistiques ? Cette action est définitive.`)) return;
    await api(`/api/sites/${site.id}`, { method: "DELETE" });
    location.search = "";
  }
  return (
    <div className="space-y-4">
      <SettingCard title="Script de suivi" sub={<>À coller dans le &lt;head&gt; de chaque page. Sans cookie : aucune bannière de consentement n'est nécessaire.</>}>
        <Copyable text={`<script defer src="${location.origin}/script.js" data-site="${site.domain}"></script>`} />
        <p className="mt-3 text-xs text-muted">Pour ne pas compter vos propres visites, ouvrez une fois <a className="text-ink underline" href={`https://${site.domain}/?searchtide=ignore`} target="_blank" rel="noreferrer">{site.domain}/?searchtide=ignore</a> sur chacun de vos appareils (<code className="font-mono">?searchtide=track</code> pour annuler).</p>
        <p className="mt-3 text-xs text-muted">Pour compter une action : <code className="font-mono">searchtide("inscription")</code> en JavaScript, ou l'attribut <code className="font-mono">data-searchtide="clic-cta"</code> sur un bouton.</p>
      </SettingCard>
      <SettingCard title="Google Search Console" sub="Mots-clés, clics, impressions et position de chaque page. Importés automatiquement toutes les 6 heures.">
        {!me.gsc ? (
          <p className="text-sm">Google n'est pas encore activé. <ActivateLink module="google" name="Google" go={go} /> : la connexion se fait dans l'interface, sans redémarrage.</p>
        ) : error ? <p role="alert" className="text-sm text-negative">{error}</p> : (
          <label className="block text-sm">Propriété Search Console
            <select className={`${inputCls} mt-2`} value={site.gsc_property ?? ""} disabled={me.demo} onChange={(e) => link(e.target.value)}>
              <option value="">Non reliée</option>
              {site.gsc_property && !props?.includes(site.gsc_property) && <option value={site.gsc_property}>{site.gsc_property}</option>}
              {props?.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {props?.length === 0 && <span className="mt-2 block text-xs text-muted">Aucune propriété visible : ajoutez l'email du compte de service comme utilisateur du site dans Search Console.</span>}
          </label>
        )}
      </SettingCard>
      <SettingCard title="Agents IA" sub="Vos agents (Claude Code, Codex, OpenCode, Hermes…) lisent les statistiques par le serveur MCP, chacun avec sa propre clé.">
        <Button variant="secondary" onClick={() => go({ site: undefined, tab: undefined, view: "agents" })}>Créer une clé pour un agent</Button>
      </SettingCard>
      {!me.demo && (
        <SettingCard title="Supprimer le site" sub="Efface le site et toutes ses statistiques. Définitif.">
          <button onClick={remove} className="h-9 rounded-full border border-negative/40 px-4 text-sm font-medium text-negative hover:bg-negative-bg">Supprimer {site.domain}</button>
        </SettingCard>
      )}
    </div>
  );
}
