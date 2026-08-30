import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "@mikro-orm/postgresql";
import { RequestContext } from "@mikro-orm/postgresql";
import { WagerTransactionEntity } from "../../src/wagering/infrastructure/persistence/entities/wagerTransaction.entity";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/wagering/domain/wagerTransaction";
import { setupIntegrationTest, teardownIntegrationTest, seedWallet, type IntegrationTestContext } from "./testSetup";

/** Força next_reference_retry_at pro passado, sem esperar o backoff real — só pra teste. */
async function forceRetryDue(ctx: IntegrationTestContext, transactionId: string) {
  await ctx.run(async () => {
    const em = RequestContext.getEntityManager()! as EntityManager;
    await em.nativeUpdate(WagerTransactionEntity, { id: transactionId }, { nextReferenceRetryAt: new Date(Date.now() - 1000) });
  });
}

describe("PendingReferenceRetryWorker", () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await setupIntegrationTest();
  });

  afterAll(async () => {
    await teardownIntegrationTest(ctx);
  });

  test("referência ainda não encontrada -> reagenda com backoff, continua PENDING_REFERENCE", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const refund = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-worker-1", providerId: "provider-a", externalTransactionId: "refund-worker-1",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-vai-chegar-depois",
      }),
    );

    const processed = await ctx.run(() => ctx.pendingReferenceRetryWorker.pollOnce());
    expect(processed).toBeGreaterThanOrEqual(1);

    const tx = await ctx.run(() => ctx.wagerTransactionRepository.findById(refund.transactionId));
    expect(tx?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx?.referenceRetryAttempts).toBeGreaterThanOrEqual(1);
    expect(tx?.nextReferenceRetryAt).toBeDefined();
  });

  test("quando a referência chega, a próxima tentativa do worker resolve com sucesso", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const refund = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-worker-2", providerId: "provider-a", externalTransactionId: "refund-worker-2",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "20.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-worker-2",
      }),
    );

    // a BET real finalmente chega
    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-worker-2", providerId: "provider-a", externalTransactionId: "bet-worker-2",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "20.00", currency: "BRL" },
      }),
    );

    await forceRetryDue(ctx, refund.transactionId);
    const processed = await ctx.run(() => ctx.pendingReferenceRetryWorker.pollOnce());
    expect(processed).toBeGreaterThanOrEqual(1);

    const tx = await ctx.run(() => ctx.wagerTransactionRepository.findById(refund.transactionId));
    expect(tx?.status).toBe(WagerTransactionStatus.Processed);

    const wallet = await ctx.run(() => ctx.walletRepository.findById(walletId));
    expect(wallet?.balance.toJSON().amount).toBe("100.00"); // 100 - 20 (bet) + 20 (refund)
  });

  test("esgotar o limite de tentativas rejeita com REFERENCE_NEVER_ARRIVED", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const refund = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-never", providerId: "provider-a", externalTransactionId: "refund-never",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "5.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-que-nunca-chega",
      }),
    );

    // esgota as tentativas (limite = 8, ver processWagerTransaction.useCase.ts)
    for (let i = 0; i < 9; i++) {
      await forceRetryDue(ctx, refund.transactionId);
      await ctx.run(() => ctx.pendingReferenceRetryWorker.pollOnce());
    }

    const tx = await ctx.run(() => ctx.wagerTransactionRepository.findById(refund.transactionId));
    expect(tx?.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx?.failureCode).toBe("REFERENCE_NEVER_ARRIVED");
  });
});