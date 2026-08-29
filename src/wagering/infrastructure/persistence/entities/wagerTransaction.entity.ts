import { defineEntity, p } from "@mikro-orm/postgresql";
import { WalletEntity } from "./wallet.entity";
import { WagerTransactionKind, WagerTransactionStatus } from "../../../domain/wagerTransaction";

export const WagerTransactionSchema = defineEntity({
  name: "WagerTransaction",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    wallet: () => p.manyToOne(WalletEntity).mapToPk(),
    playerId: p.uuid(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.enum(() => WagerTransactionKind),
    currency: p.string().length(3),
    moneyAmount: p.decimal().precision(19).scale(2),
    referenceExternalTransactionId: p.string().nullable(),
    // auto-referenciada: uma WagerTransaction pode referenciar outra da mesma tabela (REFUND/ROLLBACK)
    referenceTransaction: () => p.manyToOne(WagerTransactionEntity).mapToPk().nullable(),
    status: p.enum(() => WagerTransactionStatus),
    failureCode: p.string().nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
  uniques: [
    { name: "wt_idempotency_key_uq", properties: ["idempotencyKey"] },
    { name: "wt_provider_external_uq", properties: ["providerId", "externalTransactionId"] },
    // "uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação" —
    // só conta reversões PROCESSED (uma tentativa REJECTED/FAILED não consome a trava)
    {
      name: "wt_unique_refund_per_reference_idx",
      properties: ["referenceTransaction"],
      where: { kind: WagerTransactionKind.Refund, status: WagerTransactionStatus.Processed },
    },
    {
      name: "wt_unique_rollback_per_reference_idx",
      properties: ["referenceTransaction"],
      where: { kind: WagerTransactionKind.Rollback, status: WagerTransactionStatus.Processed },
    },
  ],
  indexes: [
    // pro worker da seção 7.1 escanear só o que precisa reprocessar
    {
      name: "wt_pending_reference_idx",
      properties: ["createdAt"],
      where: { status: WagerTransactionStatus.PendingReference },
    },
  ],
  checks: [
    { name: "wt_money_non_negative_ck", expression: (c) => `${c.moneyAmount} >= 0` },
    // espelha referencePolicyFor() do domínio: obrigatória p/ REFUND/ROLLBACK, proibida p/ BET/LOSS/OPENING, livre p/ WIN
    {
      name: "wt_reference_policy_ck",
      expression: (c) =>
        `((${c.kind} IN ('REFUND','ROLLBACK') AND ${c.referenceExternalTransactionId} IS NOT NULL) OR ` +
        `(${c.kind} = 'WIN') OR ` +
        `(${c.kind} IN ('BET','LOSS','OPENING') AND ${c.referenceExternalTransactionId} IS NULL))`,
    },
    {
      name: "wt_processed_at_consistency_ck",
      expression: (c) =>
        `((${c.status} = 'PROCESSED' AND ${c.processedAt} IS NOT NULL) OR (${c.status} != 'PROCESSED' AND ${c.processedAt} IS NULL))`,
    },
    {
      name: "wt_failure_code_consistency_ck",
      expression: (c) =>
        `((${c.status} IN ('REJECTED','FAILED') AND ${c.failureCode} IS NOT NULL) OR (${c.status} NOT IN ('REJECTED','FAILED') AND ${c.failureCode} IS NULL))`,
    },
  ],
});

export class WagerTransactionEntity extends WagerTransactionSchema.class {}
WagerTransactionSchema.setClass(WagerTransactionEntity);