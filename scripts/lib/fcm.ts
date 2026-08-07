// FCM HTTP v1 senza dipendenze: JWT RS256 firmato con node:crypto, token OAuth
// cacheato fino a scadenza. Serve solo a svegliare il watch («ring»): il payload
// non porta MAI il contenuto del messaggio — quello l'app lo scarica dal server
// via /eve/v1/app/inbox, e Google vede solo un impulso.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

let cachedToken: { token: string; exp: number } | null = null;

function loadServiceAccount(): ServiceAccount | null {
  const path = process.env.FCM_SERVICE_ACCOUNT;
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id)
      return null;
    return parsed;
  } catch {
    return null;
  }
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.exp > now + 60_000) return cachedToken.token;
  const iat = Math.floor(now / 1000);
  const b64 = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(sa.private_key, "base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`oauth ${res.status}`);
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = { token: json.access_token, exp: now + json.expires_in * 1000 };
  return cachedToken.token;
}

/**
 * Manda il segnale «ring» a ogni device registrato. Ritorna i token che FCM ha
 * rifiutato come morti (app disinstallata, token ruotato), così il chiamante può
 * potarli. Senza service account configurato è un no-op silenzioso.
 */
export async function sendRing(tokens: string[]): Promise<string[]> {
  const sa = loadServiceAccount();
  if (!sa || tokens.length === 0) return [];
  const access = await accessToken(sa);
  const invalid: string[] = [];
  for (const token of tokens) {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token,
            data: { type: "ring" },
            android: { priority: "HIGH" },
          },
        }),
      },
    );
    // 404/400 = token morto; il resto (rete, quota) non condanna il token.
    if (res.status === 404 || res.status === 400) invalid.push(token);
  }
  return invalid;
}
