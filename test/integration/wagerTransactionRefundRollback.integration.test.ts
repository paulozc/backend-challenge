import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/wagering/domain/wagerTransaction";
import { setupIntegrationTest, teardownIntegrationTest, seedWallet, type IntegrationTestContext } from "./testSetup";

describe("ProcessWagerTransactionUseCase — REFUND e ROLLBACK", () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await setupIntegrationTest();
  });

  afterAll(async () => {
    await teardownIntegrationTest(ctx);
  });

  test("REFUND válido de uma BET credita de volta", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-ref", providerId: "provider-a", externalTransactionId: "bet-ref",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "30.00", currency: "BRL" },
      }),
    );

    const refund = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-1", providerId: "provider-a", externalTransactionId: "refund-1",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "30.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-ref",
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance.amount).toBe("100.00");
  });

  test("segundo REFUND na mesma referência é rejeitado (REFERENCE_ALREADY_REVERSED)", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-double", providerId: "provider-a", externalTransactionId: "bet-double",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
      }),
    );
    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-a", providerId: "provider-a", externalTransactionId: "refund-a",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-double",
      }),
    );

    const secondRefund = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-b", providerId: "provider-a", externalTransactionId: "refund-b",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-double",
      }),
    );

    expect(secondRefund.status).toBe(WagerTransactionStatus.Rejected);
    const tx = await ctx.run(() => ctx.wagerTransactionRepository.findById(secondRefund.transactionId));
    expect(tx?.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
  });

  test("ROLLBACK de um WIN inverte CREDIT em DEBIT", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:win-rb", providerId: "provider-a", externalTransactionId: "win-rb",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Win, money: { amount: "20.00", currency: "BRL" },
      }),
    );

    const rollback = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:rollback-win", providerId: "provider-a", externalTransactionId: "rollback-win",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Rollback, money: { amount: "20.00", currency: "BRL" },
        referenceExternalTransactionId: "win-rb",
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance.amount).toBe("100.00"); // 100 + 20 (win) - 20 (rollback)
  });

  test("REFUND referenciando um WIN é rejeitado — REFUND só referencia BET", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:win-for-refund", providerId: "provider-a", externalTransactionId: "win-for-refund",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Win, money: { amount: "10.00", currency: "BRL" },
      }),
    );

    const refund = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-of-win", providerId: "provider-a", externalTransactionId: "refund-of-win",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: "win-for-refund",
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    const tx = await ctx.run(() => ctx.wagerTransactionRepository.findById(refund.transactionId));
    expect(tx?.failureCode).toBe("REFERENCE_KIND_NOT_ALLOWED");
  });

  test("REFUND com referência ainda não recebida vira PENDING_REFERENCE", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const refund = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-pending", providerId: "provider-a", externalTransactionId: "refund-pending",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-que-nao-chegou-ainda",
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.balance.amount).toBe("100.00"); // não mexeu no saldo
  });

  test("replay idempotente de REFUND retorna o saldo observado no momento original, não o atual", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-for-replay", providerId: "provider-a", externalTransactionId: "bet-for-replay",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "20.00", currency: "BRL" },
      }),
    );
    const refund = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-replay", providerId: "provider-a", externalTransactionId: "refund-replay",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "20.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-for-replay",
      }),
    );
    expect(refund.balance.amount).toBe("100.00");

    // outra operação muda o saldo depois
    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-after", providerId: "provider-a", externalTransactionId: "bet-after",
        playerId, walletId, roundId: "round-2", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
      }),
    );

    const replay = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-replay", providerId: "provider-a", externalTransactionId: "refund-replay",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "20.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-for-replay",
      }),
    );

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe("100.00"); // saldo observado no momento do REFUND, não os 90.00 atuais
  });
});