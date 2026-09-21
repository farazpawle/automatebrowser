import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface AuthChallenge {
  scheme: "hmac-sha256";
  challenge: string;
}

export interface AuthResponse extends AuthChallenge {
  response: string;
}

/**
 * Optional WebSocket auth (shared secret). Set `AUTOMATE_BROWSER_TOKEN` on the relay
 * and the same token in the extension popup/controller environment to require
 * proof-of-possession. The secret is never sent over the socket; peers sign the
 * relay's nonce with HMAC-SHA256.
 *
 * Off by default (no env var) keeps the historical local no-auth workflow.
 */
export function getAuthToken(): string | undefined {
  const t = process.env.AUTOMATE_BROWSER_TOKEN;
  return t && t.trim() ? t.trim() : undefined;
}

export function createAuthChallenge(): AuthChallenge {
  return {
    scheme: "hmac-sha256",
    challenge: randomBytes(24).toString("base64url"),
  };
}

export function signAuthChallenge(token: string, challenge: string): AuthResponse {
  return {
    scheme: "hmac-sha256",
    challenge,
    response: createHmac("sha256", token).update(challenge).digest("base64url"),
  };
}

export function verifyAuthResponse(
  token: string,
  expectedChallenge: string,
  auth: unknown,
): boolean {
  if (!auth || typeof auth !== "object") return false;
  const payload = auth as Partial<AuthResponse>;
  if (
    payload.scheme !== "hmac-sha256" ||
    payload.challenge !== expectedChallenge ||
    typeof payload.response !== "string" ||
    payload.response.length === 0
  ) {
    return false;
  }

  const expected = signAuthChallenge(token, expectedChallenge).response;
  const a = Buffer.from(expected);
  const b = Buffer.from(payload.response);
  return a.length === b.length && timingSafeEqual(a, b);
}
