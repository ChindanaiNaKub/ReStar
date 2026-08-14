import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

export function createPkceChallenge(verifier: string) {
  return hashToken(verifier);
}

function tokenEncryptionKey(encodedKey = process.env.GITHUB_TOKEN_ENCRYPTION_KEY) {
  if (!encodedKey) throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY is required");

  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

export function encryptAccessToken(accessToken: string, encodedKey?: string) {
  const key = tokenEncryptionKey(encodedKey);

  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(accessToken, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptAccessToken(encrypted: string, encodedKey?: string) {
  const [version, encodedNonce, encodedTag, encodedCiphertext] = encrypted.split(".");
  if (version !== "v1" || !encodedNonce || !encodedTag || !encodedCiphertext) {
    throw new Error("Stored GitHub token has an invalid format");
  }

  const decipher = createDecipheriv("aes-256-gcm", tokenEncryptionKey(encodedKey), Buffer.from(encodedNonce, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
