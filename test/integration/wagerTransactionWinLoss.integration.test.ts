import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/wagering/domain/wagerTransaction";
import { setupIntegrationTest, teardownIntegrationTest, seedWallet, type IntegrationTestContext } from "./testSetup";

describe("ProcessWagerTransactionUseCase — WIN e LOSS", () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await setupIntegrationTest();
  });

  afterAll(async () => {
    await teardownIntegrationTest(ctx);
  });

  test("WIN sem referência credita normalmente", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const result = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:win-1", providerId: "provider-a", externalTransactionId: "win-1",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Win, money: { amount: "50.00", currency: "BRL" },
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe("150.00");
  });

  test("WIN com referência válida (mesma rodada) credita e linka a referência", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const bet = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-for-win", providerId: "provider-a", externalTransactionId: "bet-for-win",
        playerId, walletId, roundId: "round-2", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "20.00", currency: "BRL" },
      }),
    );

    const win = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:win-2", providerId: "provider-a", externalTransactionId: "win-2",
        playerId, walletId, roundId: "round-2", gameId: "game-1",
        kind: WagerTransactionKind.Win, money: { amount: "40.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-for-win",
      }),
    );

    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance.amount).toBe("120.00"); // 100 - 20 (bet) + 40 (win)

    const winTx = await ctx.run(() => ctx.wagerTransactionRepository.findById(win.transactionId));
    expect(winTx?.referenceTransactionId).toBe(bet.transactionId);
  });

  test("WIN com referência de rodada diferente é rejeitado (REFERENCE_MISMATCH)", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-round-a", providerId: "provider-a", externalTransactionId: "bet-round-a",
        playerId, walletId, roundId: "round-a", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
      }),
    );

    const win = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:win-wrong-round", providerId: "provider-a", externalTransactionId: "win-wrong-round",
        playerId, walletId, roundId: "round-b", gameId: "game-1", // rodada diferente
        kind: WagerTransactionKind.Win, money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-round-a",
      }),
    );

    expect(win.status).toBe(WagerTransactionStatus.Rejected);
    const winTx = await ctx.run(() => ctx.wagerTransactionRepository.findById(win.transactionId));
    expect(winTx?.failureCode).toBe("REFERENCE_MISMATCH");
  });

  test("LOSS não muda o saldo nem gera lançamento no ledger", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const result = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:loss-1", providerId: "provider-a", externalTransactionId: "loss-1",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Loss, money: { amount: "15.00", currency: "BRL" },
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe("100.00"); // intacto

    const entry = await ctx.run(() => ctx.walletLedgerEntryRepository.findByTransactionId(result.transactionId));
    expect(entry).toBeNull();
  });

  test("replay idempotente de LOSS funciona sem erro (não tenta achar lançamento inexistente)", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:loss-replay", providerId: "provider-a", externalTransactionId: "loss-replay",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Loss, money: { amount: "5.00", currency: "BRL" },
      }),
    );

    const replay = await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:loss-replay", providerId: "provider-a", externalTransactionId: "loss-replay",
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Loss, money: { amount: "5.00", currency: "BRL" },
      }),
    );

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe("100.00");
  });
});