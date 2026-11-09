// Liste des connecteurs disponibles. Pour en ajouter un : créer server/connectors/<id>.ts, l'importer ici,
// et ajouter sa fixture dans fixtures.ts (le test de contrat échoue s'il manque).
import "./builtin.ts";
import "./stripe.ts";
import "./smtp.ts";
import "./ntfy.ts";
import "./google.ts";
import "./postgres.ts";

export { register, get, all, publicManifest, runTest, runCollect, realCtx } from "./registry.ts";
export * from "./types.ts";
