// Piège de focus et fermeture par Échap, partagé par les tiroirs et la palette.
import { useEffect } from "react";

export function useDrawerKeys(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const el = ref.current;
    const focusable = () => [...(el?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [])].filter((x) => x.getClientRects().length > 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const f = focusable(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1], active = document.activeElement;
      if (e.shiftKey && (active === first || !el?.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !el?.contains(active))) { e.preventDefault(); first.focus(); }
    };
    const onFocusIn = (e: FocusEvent) => { if (el && !el.contains(e.target as Node)) focusable()[0]?.focus(); };
    // Focus perdu vers la page (aucune cible) alors que le tiroir est ouvert : on le ramène dans le tiroir
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget) return;
      setTimeout(() => { if (el?.isConnected && !el.contains(document.activeElement)) focusable()[0]?.focus(); }, 0);
    };
    document.addEventListener("keydown", onKey); document.addEventListener("focusin", onFocusIn); document.addEventListener("focusout", onFocusOut);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("focusin", onFocusIn); document.removeEventListener("focusout", onFocusOut); };
  }, [ref, onClose]);
}
