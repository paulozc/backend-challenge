import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "@mikro-orm/postgresql";
import { RequestContext } from "@mikro-orm/postgresql";
import { OutboxMessageEntity } from "../../src/wagering/infrastructure/persistence/entities/outboxMessage.entity";
import { WagerTransactionKind } from "../../src/wagering/domain/wagerTransaction";
import { setupIntegrationTest, teardownIntegrationTest, type IntegrationTestContext } from "./testSetup";

async function outboxEventTypes(ctx: IntegrationTestContext): Promise<string[]> {
  return ctx.run(async () => {
    const em = RequestContext.getEntityManager()! as EntityManager;
    const rows = await em.find(OutboxMessageEntity, {}, { orderBy: { occurredAt: "asc" } });
    return rows.map((r) => r.eventType);
  });
}

describe("Eventos de integração (outbox)", () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await setupIntegrationTest();
  });

  afterAll(async () => {
    await teardownIntegrationTest(ctx);
  });

  test("abrir wallet com saldo positivo gera WagerTransactionProcessed + WalletBalanceChanged", async () => {
    const playerId = randomUUID();
    await ctx.run(() => ctx.openWallet.execute({ playerId, initialBalance: { amount: "500.00", currency: "BRL" } }));

    const events = await outboxEventTypes(ctx);
    expect(events).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("abrir wallet com saldo ZERO não gera nenhum evento", async () => {
    const before = await outboxEventTypes(ctx);
    const playerId = randomUUID();
    await ctx.run(() => ctx.openWallet.execute({ playerId, initialBalance: { amount: "0.00", currency: "BRL" } }));

    const after = await outboxEventTypes(ctx);
    expect(after.length).toBe(before.length);
  });

  test("BET rejeitado por saldo insuficiente gera só WagerTransactionRejected", async () => {
    const playerId = randomUUID();
    const wallet = await ctx.run(() =>
      ctx.openWallet.execute({ playerId, initialBalance: { amount: "10.00", currency: "BRL" } }),
    );
    const before = await outboxEventTypes(ctx);

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-insufficient", providerId: "provider-a", externalTransactionId: "bet-insufficient",
        playerId, walletId: wallet.id, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "9999.00", currency: "BRL" },
      }),
    );

    const after = await outboxEventTypes(ctx);
    const newEvents = after.slice(before.length);
    expect(newEvents).toEqual(["WagerTransactionRejected"]);
  });

  test("LOSS gera só WagerTransactionProcessed, sem WalletBalanceChanged (não afeta saldo)", async () => {
    const playerId = randomUUID();
    const wallet = await ctx.run(() =>
      ctx.openWallet.execute({ playerId, initialBalance: { amount: "50.00", currency: "BRL" } }),
    );
    const before = await outboxEventTypes(ctx);

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:loss-outbox", providerId: "provider-a", externalTransactionId: "loss-outbox",
        playerId, walletId: wallet.id, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Loss, money: { amount: "5.00", currency: "BRL" },
      }),
    );

    const after = await outboxEventTypes(ctx);
    expect(after.slice(before.length)).toEqual(["WagerTransactionProcessed"]);
  });

  test("REFUND com referência pendente gera WagerTransactionPendingReference", async () => {
    const playerId = randomUUID();
    const wallet = await ctx.run(() =>
      ctx.openWallet.execute({ playerId, initialBalance: { amount: "50.00", currency: "BRL" } }),
    );
    const before = await outboxEventTypes(ctx);

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:refund-outbox-pending", providerId: "provider-a", externalTransactionId: "refund-outbox-pending",
        playerId, walletId: wallet.id, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Refund, money: { amount: "5.00", currency: "BRL" },
        referenceExternalTransactionId: "nao-existe",
      }),
    );

    const after = await outboxEventTypes(ctx);
    expect(after.slice(before.length)).toEqual(["WagerTransactionPendingReference"]);
  });

  test("replay idempotente não gera nenhum evento novo", async () => {
    const playerId = randomUUID();
    const wallet = await ctx.run(() =>
      ctx.openWallet.execute({ playerId, initialBalance: { amount: "50.00", currency: "BRL" } }),
    );
    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-replay-outbox", providerId: "provider-a", externalTransactionId: "bet-replay-outbox",
        playerId, walletId: wallet.id, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "5.00", currency: "BRL" },
      }),
    );
    const before = await outboxEventTypes(ctx);

    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey: "provider-a:bet-replay-outbox", providerId: "provider-a", externalTransactionId: "bet-replay-outbox",
        playerId, walletId: wallet.id, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "5.00", currency: "BRL" },
      }),
    );

    const after = await outboxEventTypes(ctx);
    expect(after.length).toBe(before.length);
  });

  test("o worker publica todas as mensagens pendentes, em quantos lotes forem necessários", async () => {
    const playerId = randomUUID();
    await ctx.run(() => ctx.openWallet.execute({ playerId, initialBalance: { amount: "77.00", currency: "BRL" } }));

    // drena em loop — mesmo comportamento do worker real (scripts/outboxWorker.ts), que
    // continua chamando pollOnce() até não sobrar nada, não confia numa única chamada
    let totalProcessed = 0;
    for (let i = 0; i < 20; i++) {
      const processed = await ctx.run(() => ctx.outboxPublisherWorker.pollOnce());
      totalProcessed += processed;
      if (processed === 0) break;
    }
    expect(totalProcessed).toBeGreaterThan(0);

    const pendingAfter = await ctx.run(async () => {
      const em = RequestContext.getEntityManager()! as EntityManager;
      return em.count(OutboxMessageEntity, { publishedAt: null });
    });
    expect(pendingAfter).toBe(0);
  });
});