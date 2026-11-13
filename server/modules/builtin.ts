// Les 12 modules livrés avec Searchtide (spec §4). Les outils MCP, routes, tâches et actions sont branchés module par module.
import { registerModule } from "./registry.ts";

registerModule({
  id: "analytics", name: "Analytics", core: true, scope: "projet", category: "trafic", connectors: ["analytics"],
  description: "Les visites de vos sites sans cookie : pages, canaux, pays, appareils, événements, part du trafic venu des assistants IA.",
  tabs: [{ id: "trafic", label: "Trafic" }],
  widgets: {
    traffic_by_project: { label: "Visites par projet", description: "Barres empilées jour par jour, une couleur par projet.", size: "two-thirds", options: {} },
    site: { label: "Trafic d'un site", description: "Visiteurs par jour et provenance d'un site suivi.", size: "half", options: { site: "domaine, ex. exemple.com (obligatoire)" } },
  },
});

registerModule({
  id: "projets", name: "Projets et KPI", core: true, scope: "instance", category: "produit", connectors: ["manual"],
  description: "Vos projets, leurs KPI, objectifs, entonnoirs et jalons, y compris les chiffres saisis à la main et les KPI calculés.",
  widgets: {
    pulse: { label: "Chiffres du portefeuille", description: "Visites, clics Google, chiffre d'affaires, nouveaux contacts, relances : tous projets confondus.", size: "full", options: {} },
    todo: { label: "À traiter", description: "Alertes : relevés en panne, sites muets, baisses, objectifs en retard, relances, publications du jour.", size: "third", options: {} },
    projects_table: { label: "Projets", description: "Tableau comparatif de tous les projets (visites, Google, CA, contacts, indicateur clé, objectif).", size: "full", options: {} },
    project: { label: "Un projet", description: "Les indicateurs d'un projet en chiffres.", size: "full", options: { project: "id ou crm_key du projet (obligatoire)" } },
    indicator: { label: "Courbe d'un indicateur", description: "Graphique jour par jour d'un indicateur, aux couleurs de son projet.", size: "half", options: { indicator: "id de l'indicateur (obligatoire, voir projects_kpis)" } },
    goals: { label: "Objectifs", description: "Avancement de tous les objectifs, avec projection au rythme actuel.", size: "half", options: { project: "id ou crm_key pour se limiter à un projet (facultatif)" } },
  },
});

registerModule({
  id: "pages", name: "Pages", core: true, scope: "instance", category: "produit",
  description: "Des pages de blocs à composer vous-même ou à faire ranger par vos agents.",
  widgets: {
    note: { label: "Note", description: "Texte libre (Markdown simple : titres #, listes -, **gras**, liens). Idéal pour un briefing écrit par un agent.", size: "half", options: { text: "contenu Markdown (obligatoire)" } },
  },
});

registerModule({
  id: "agents", name: "Agents IA", core: true, scope: "instance", category: "produit",
  description: "Une clé par agent (Claude Code, Codex, OpenCode, Hermes…), le serveur MCP et le journal de leurs appels.",
  widgets: {
    agent_log: { label: "Journal des agents", description: "Les derniers appels des agents IA, avec leur nom.", size: "half", options: { agent: "nom d'un agent pour filtrer (facultatif)", limit: "nombre de lignes, 5 à 50 (facultatif)" } },
  },
});

registerModule({
  id: "google", name: "Google", scope: "projet", category: "referencement", connectors: ["google"],
  description: "Search Console : clics, impressions, position et mots-clés à faire monter. Google Play en option : installations et note.",
  tabs: [{ id: "recherche", label: "Recherche" }],
  widgets: {
    seo: { label: "Mots-clés à travailler", description: "Mots-clés en position 4 à 20 d'un site, les plus faciles à faire monter.", size: "half", options: { site: "domaine (obligatoire)" } },
  },
});

registerModule({
  id: "stripe", name: "Stripe", scope: "projet", category: "revenus", connectors: ["stripe"],
  description: "Chiffre d'affaires net, revenu mensuel récurrent, abonnements actifs, nouveaux clients.",
  tabs: [{ id: "revenus", label: "Revenus" }],
});

registerModule({
  id: "produit", name: "Produit", scope: "projet", category: "produit", connectors: ["postgres", "supabase", "jsonapi"],
  description: "Les chiffres de votre produit : inscriptions, utilisateurs actifs, activation, rétention, depuis votre base ou une adresse JSON.",
  tabs: [{ id: "produit", label: "Produit" }],
});

registerModule({
  id: "pagespeed", name: "PageSpeed", scope: "projet", category: "referencement", connectors: ["pagespeed"],
  description: "Score de performance, score SEO, LCP et CLS de vos pages.",
});

registerModule({
  id: "crm", name: "Contacts", scope: "projet", category: "commercial",
  description: "Prospects et clients, pipeline, échanges et relances.",
  tabs: [{ id: "contacts", label: "Contacts" }],
  widgets: {
    pipeline: { label: "Pipeline commercial", description: "Contacts par étape, montant en négociation, gagné ce mois.", size: "half", options: {} },
  },
});

registerModule({
  id: "publications", name: "Publications", scope: "projet", category: "commercial",
  description: "Calendrier éditorial ; les publications publiées s'affichent sur les courbes.",
  widgets: {
    publications: { label: "Publications de la semaine", description: "Calendrier éditorial de la semaine en cours.", size: "half", options: {} },
  },
});

registerModule({
  id: "prospection", name: "Prospection", scope: "instance", category: "commercial", connectors: ["smtp"],
  description: "Modèles d'e-mails, séquences de relance et désinscription, depuis la fiche d'un contact.",
});

registerModule({
  id: "rdv", name: "Rendez-vous", scope: "instance", category: "commercial", connectors: ["smtp", "gcal", "caldav"],
  description: "Un lien de réservation public par type de RDV (Meet, Teams, Zoom ou téléphone), invitation .ics, flux iCal, Google Agenda avec lien Meet automatique, ou agenda CalDAV (iCloud, Nextcloud, Fastmail), rendez-vous classés par projet.",
});

registerModule({
  id: "notifications", name: "Notifications", scope: "instance", category: "notifications", connectors: ["smtp", "ntfy"],
  description: "Rapport hebdomadaire par e-mail et alertes sur le téléphone.",
});
