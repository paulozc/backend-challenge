import { WalletLedgerEntry } from "../domain/walletLedgerEntry";

export abstract class WalletLedgerEntryRepository {
  /** Só criação — WalletLedgerEntry nunca é atualizado, é append-only por design. */
  abstract create(entry: WalletLedgerEntry): Promise<void>;

  /** Usado no replay idempotente: recupera o saldo observado no momento do processamento original. */
  abstract findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
}