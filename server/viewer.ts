// Contexte de lecture : masquer les configs héritées pour les clés, jamais pour la session admin.
import { AsyncLocalStorage } from "node:async_hooks";
const store = new AsyncLocalStorage<{ mask: boolean }>();
export const shouldMaskConfig = () => store.getStore()?.mask === true;
export const runAsViewer = <T>(mask: boolean, fn: () => T): T => store.run({ mask }, fn);
