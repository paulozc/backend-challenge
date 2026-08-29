import { WalletLedgerEntry } from "../domain/walletLedgerEntry";

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export abstract class WalletLedgerEntryRepository {
  /** Só criação — WalletLedgerEntry nunca é atualizado, é append-only por design. */
  abstract create(entry: WalletLedgerEntry): Promise<void>;

  /** Usado no replay idempotente: recupera o saldo observado no momento do processamento original. */
  abstract findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;

  /** Paginação por keyset (não offset) — estável mesmo com inserções concorrentes durante a paginação. */
  abstract findByWallet(walletId: string, after: LedgerCursor | null, limit: number): Promise<WalletLedgerEntry[]>;
}