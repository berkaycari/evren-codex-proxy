import { safeStorage } from "electron";
import type { CredentialEncryption } from "./credential-service.js";

export class ElectronSafeStorageEncryption implements CredentialEncryption {
  isAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === "linux") {
      return safeStorage.getSelectedStorageBackend() !== "basic_text";
    }
    return true;
  }

  encrypt(value: string): Buffer {
    if (!this.isAvailable()) throw new Error("Secure persistence is unavailable.");
    return safeStorage.encryptString(value);
  }

  decrypt(value: Buffer): string {
    if (!this.isAvailable()) throw new Error("Secure persistence is unavailable.");
    return safeStorage.decryptString(value);
  }
}
