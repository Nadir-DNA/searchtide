// §14.4 : la 2FA est facultative. L'avertissement de démarrage est informatif, jamais bloquant,
// tient compte de la 2FA activée dans les Réglages et peut être coupé par QUIET_2FA_WARNING=1.

export function missing2faWarning(opts: {
  inContainer: boolean; hostname: string; envTotp: boolean; configured: boolean; demo: boolean; quiet: boolean;
}): string | null {
  if (opts.quiet || opts.demo || opts.envTotp || opts.configured) return null;
  if (opts.inContainer || opts.hostname === "127.0.0.1" || opts.hostname === "localhost") return null;
  return `Attention : Searchtide est joignable sur ${opts.hostname} sans double authentification. `
    + "Elle reste facultative ; l'activer dans Réglages est recommandé si l'instance est exposée à Internet. "
    + "Cet avertissement se coupe avec QUIET_2FA_WARNING=1.";
}
