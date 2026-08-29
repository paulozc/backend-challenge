import { WagerTransaction } from "../domain/wagerTransaction";

export abstract class WagerTransactionRepository {
  abstract findById(id: string): Promise<WagerTransaction | null>;
  abstract findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  abstract findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;

  /** Cria se ainda não existe, atualiza (transição de status) se já existe. */
  abstract save(transaction: WagerTransaction): Promise<void>;
}