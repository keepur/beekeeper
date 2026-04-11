import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;

export interface CryptoContext {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * Derive an AES-256 key from a secret using PBKDF2.
 * Salt is persisted to `<dataDir>/devices.key.salt`.
 * If the salt file doesn't exist, generates a random one.
 */
export function createCryptoContext(secret: string, dataDir: string): CryptoContext {
  const saltPath = join(dataDir, "devices.key.salt");
  let salt: Buffer;

  if (existsSync(saltPath)) {
    salt = readFileSync(saltPath);
  } else {
    salt = randomBytes(32);
    writeFileSync(saltPath, salt, { mode: 0o600 });
  }

  const key = pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      // Format: base64(iv + authTag + ciphertext)
      return Buffer.concat([iv, authTag, encrypted]).toString("base64");
    },

    decrypt(ciphertext: string): string {
      const data = Buffer.from(ciphertext, "base64");
      const iv = data.subarray(0, IV_LENGTH);
      const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
      decipher.setAuthTag(authTag);
      return decipher.update(encrypted, undefined, "utf-8") + decipher.final("utf-8");
    },
  };
}
