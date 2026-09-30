import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CredentialStatusDto, PersistenceMode } from "../shared/contracts.js";

export interface CredentialEncryption {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

interface PersistedCredential {
  version: 1;
  ciphertext: string;
}

export class CredentialService {
  private sessionCredential: string | undefined;

  constructor(
    private readonly filePath: string,
    private readonly encryption: CredentialEncryption,
  ) {}

  async getStatus(): Promise<CredentialStatusDto> {
    const secureExists = await this.hasPersistedCredential();
    return {
      exists: this.sessionCredential !== undefined || secureExists,
      persistence: this.sessionCredential !== undefined ? "session" : secureExists ? "secure" : "none",
      securePersistenceAvailable: this.encryption.isAvailable(),
    };
  }

  async setCredential(apiKey: string, persistence: PersistenceMode): Promise<void> {
    const value = validateApiKey(apiKey);
    if (persistence === "session") {
      this.sessionCredential = value;
      await this.removePersistedCredential();
      return;
    }
    if (!this.encryption.isAvailable()) throw new SecurePersistenceUnavailableError();
    const encrypted = this.encryption.encrypt(value);
    const payload: PersistedCredential = { version: 1, ciphertext: encrypted.toString("base64") };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      encrypted.fill(0);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    this.sessionCredential = undefined;
  }

  async clearCredential(): Promise<void> {
    this.sessionCredential = undefined;
    await this.removePersistedCredential();
  }

  async withCredential<T>(operation: (apiKey: string) => Promise<T>): Promise<T> {
    const session = this.sessionCredential;
    if (session !== undefined) return operation(session);
    if (!this.encryption.isAvailable()) throw new CredentialUnavailableError();
    const persisted = await this.readPersistedCredential();
    if (!persisted) throw new CredentialUnavailableError();
    const encrypted = Buffer.from(persisted.ciphertext, "base64");
    try {
      const plaintext = this.encryption.decrypt(encrypted);
      return await operation(plaintext);
    } finally {
      encrypted.fill(0);
    }
  }

  clearSessionMemory(): void {
    this.sessionCredential = undefined;
  }

  private async hasPersistedCredential(): Promise<boolean> {
    if (!this.encryption.isAvailable()) return false;
    try {
      return (await this.readPersistedCredential()) !== undefined;
    } catch (error) {
      if (error instanceof CredentialUnavailableError) return false;
      throw error;
    }
  }

  private async readPersistedCredential(): Promise<PersistedCredential | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new CredentialUnavailableError();
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const record = value as Record<string, unknown>;
      if (record.version !== 1 || typeof record.ciphertext !== "string" || !record.ciphertext) throw new Error();
      const decoded = Buffer.from(record.ciphertext, "base64");
      if (decoded.length === 0 || decoded.toString("base64") !== record.ciphertext) throw new Error();
      decoded.fill(0);
      return { version: 1, ciphertext: record.ciphertext };
    } catch {
      throw new CredentialUnavailableError();
    }
  }

  private async removePersistedCredential(): Promise<void> {
    await unlink(this.filePath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

export class SecurePersistenceUnavailableError extends Error {
  readonly code = "secure_persistence_unavailable";
  constructor() {
    super("Bu cihazda güvenli anahtar saklama kullanılamıyor. Oturumluk modu kullanabilirsiniz.");
  }
}

export class CredentialUnavailableError extends Error {
  readonly code = "credential_unavailable";
  constructor() {
    super("EVREN API anahtarı kullanılamıyor.");
  }
}

function validateApiKey(apiKey: string): string {
  const value = apiKey.trim();
  if (!value || value.length > 10_000 || /[\r\n\u0000]/.test(value)) throw new Error("EVREN API key is invalid.");
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
