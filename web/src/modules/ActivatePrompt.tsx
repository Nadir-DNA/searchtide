// Invitation à activer un module, affichée à la place d'un chiffre qu'on ne mesure pas (jamais un 0 trompeur).
import { Button, Card } from "../ui";

type Go = (n: Record<string, string | undefined>) => void;
export const openModule = (go: Go, module: string) => go({ site: undefined, tab: undefined, id: undefined, view: "modules", open: module });

/** Lien court, dans une tuile de chiffres. */
export function ActivateLink({ module, name, go }: { module: string; name: string; go: Go }) {
  return <button type="button" onClick={() => openModule(go, module)} className="text-accent underline-offset-2 hover:underline">Activer {name}</button>;
}

/** Bloc entier d'un module inactif. */
export function ActivatePrompt({ module, name, what, title, go }: { module: string; name: string; what: string; title: string; go: Go }) {
  return (
    <Card title={title}>
      <p className="text-sm text-muted">Activez {name} pour voir {what}.</p>
      <div className="mt-3"><Button variant="secondary" onClick={() => openModule(go, module)}>Activer {name}</Button></div>
    </Card>
  );
}
