export interface VaultEnvelope {
  format: string;
  cipher: string;
  kdf: { name: string; iterations: number; keylen: number; digest: string; salt: string };
  iv: string;
  tag: string;
  ct: string;
}
export const VAULT_FORMAT: string;
export const VAULT_MIN_ITERATIONS: number;
export function parseVault(input: unknown): VaultEnvelope;
export function vaultInfo(env: VaultEnvelope): { format: string; cipher: string; kdf: string; bytes: number };
export function unlockVault(input: unknown, passphrase: string): Promise<string>;
