import { WagerTransaction, WagerTransactionKind } from "../domain/wagerTransaction";

export abstract class WagerTransactionRepository {
  abstract findById(id: string): Promise<WagerTransaction | null>;
  abstract findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  abstract findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;

  /** Usado por REFUND/ROLLBACK: existe uma reversão PROCESSED do mesmo tipo pra essa referência? */
  abstract findProcessedReversalByReference(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null>;

  /** Cria se ainda não existe, atualiza (transição de status) se já existe. */
  abstract save(transaction: WagerTransaction): Promise<void>;

  /** PENDING_REFERENCE prontas pro worker de reprocessamento tentar de novo (seção 7.1). */
  abstract findDuePendingReferences(limit: number): Promise<WagerTransaction[]>;
}