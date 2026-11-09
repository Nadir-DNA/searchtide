// Active la double authentification : crée un secret, affiche le QR code à scanner et l'enregistre dans .env.
// Usage : npm run 2fa   (puis redémarrez l'instance)
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import QRCode from "qrcode";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const bits = [...randomBytes(20)].map((b) => b.toString(2).padStart(8, "0")).join("");
const secret = bits.match(/.{5}/g).map((b) => B32[parseInt(b, 2)]).join("");
const uri = `otpauth://totp/Searchtide?secret=${secret}&issuer=Searchtide&algorithm=SHA1&digits=6&period=30`;
console.log(await QRCode.toString(uri, { type: "terminal", small: true }));
console.log("Scannez ce QR code avec Google Authenticator, Authy ou 1Password.");
console.log("Sans appareil photo, saisissez ce secret à la main :", secret.match(/.{4}/g).join(" "));
const env = new URL("../.env", import.meta.url);
let text = ""; try { text = readFileSync(env, "utf8"); } catch {}
writeFileSync(env, text.split("\n").filter((l) => l && !l.startsWith("TOTP_SECRET=")).concat(`TOTP_SECRET=${secret}`).join("\n") + "\n");
chmodSync(env, 0o600);
console.log("\nEnregistré dans .env. Redémarrez l'instance : la connexion demandera désormais le code.");
