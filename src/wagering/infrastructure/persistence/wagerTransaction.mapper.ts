import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../domain/wagerTransaction";
import { Money } from "../../domain/money";
import { WagerTransactionEntity } from "./entities/wagerTransaction.entity";

/** DB (via MikroORM) -> domínio. Usa WagerTransaction.rehydrate() — não revalida transições. */
export function wagerTransactionToDomain(entity: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.wallet, // mapToPk() -> uuid puro
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind as WagerTransactionKind,
    money: Money.from({ amount: entity.moneyAmount, currency: entity.currency }),
    referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
    createdAt: entity.createdAt,
    status: entity.status as WagerTransactionStatus,
    referenceTransactionId: entity.referenceTransaction ?? undefined,
    failureCode: entity.failureCode ?? undefined,
    processedAt: entity.processedAt ?? undefined,
    referenceRetryAttempts: entity.referenceRetryAttempts,
    nextReferenceRetryAt: entity.nextReferenceRetryAt ?? undefined,
  });
}

/**
 * domínio -> dado pra criar uma linha nova (usar com em.create(WagerTransactionEntity, ...)).
 * Precisa disso porque, ao contrário do WalletLedgerEntry, uma WagerTransaction É criada
 * primeiro em PENDING e só ganha status final depois — então existe um momento de "criar"
 * separado de "atualizar" (ver applyWagerTransactionToEntity abaixo).
 */
export function wagerTransactionToEntityData(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    wallet: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    currency: tx.money.currency,
    moneyAmount: tx.money.toJSON().amount,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransaction: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    createdAt: tx.createdAt,
    processedAt: tx.processedAt ?? null,
    referenceRetryAttempts: tx.referenceRetryAttempts,
    nextReferenceRetryAt: tx.nextReferenceRetryAt ?? null,
  };
}

/**
 * domínio -> DB: aplica uma transição de estado (markProcessed/reject/fail/markPendingReference)
 * numa entidade já carregada e rastreada pelo EntityManager.
 */
export function applyWagerTransactionToEntity(tx: WagerTransaction, entity: WagerTransactionEntity): void {
  entity.status = tx.status;
  entity.referenceTransaction = tx.referenceTransactionId ?? null;
  entity.failureCode = tx.failureCode ?? null;
  entity.processedAt = tx.processedAt ?? null;
  entity.referenceRetryAttempts = tx.referenceRetryAttempts;
  entity.nextReferenceRetryAt = tx.nextReferenceRetryAt ?? null;
}