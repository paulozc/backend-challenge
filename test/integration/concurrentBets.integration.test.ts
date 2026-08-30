import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "@mikro-orm/postgresql";
import { RequestContext } from "@mikro-orm/postgresql";
import { WalletLedgerEntryEntity } from "../../src/wagering/infrastructure/persistence/entities/walletLedgerEntry.entity";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/wagering/domain/wagerTransaction";
import {
  setupIntegrationTest,
  teardownIntegrationTest,
  seedWallet,
  type IntegrationTestContext,
} from "./testSetup";

describe("seção 8 — cenário obrigatório: duas apostas simultâneas sobre o mesmo saldo", () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await setupIntegrationTest();
  });

  afterAll(async () => {
    await teardownIntegrationTest(ctx);
  });

  test("apenas uma das duas apostas concorrentes de 80 sobre saldo 100 é processada", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const submit = (externalTransactionId: string) =>
      ctx.run(() =>
        ctx.processWagerTransaction.execute({
          idempotencyKey: `provider-a:${externalTransactionId}`,
          providerId: "provider-a",
          externalTransactionId,
          playerId,
          walletId,
          roundId: "round-concurrent",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "80.00", currency: "BRL" },
        }),
      );

    // Promise.all -> as duas chamadas rodam de verdade em paralelo, não em sequência.
    // O lock pessimista (SELECT ... FOR UPDATE) na wallet é o que garante que só uma
    // delas enxerga o saldo "fresco" na hora de decidir se debita ou rejeita.
    const [resultA, resultB] = await Promise.all([submit("concurrent-a"), submit("concurrent-b")]);

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());

    const finalWallet = await ctx.run(() => ctx.walletRepository.findById(walletId));
    expect(finalWallet?.balance.toJSON().amount).toBe("20.00");

    // exatamente 1 lançamento de débito no ledger — nunca 0, nunca 2
    const ledgerEntries = await ctx.run(async () => {
      const em = RequestContext.getEntityManager()! as EntityManager;
      return em.count(WalletLedgerEntryEntity, { wallet: walletId });
    });
    expect(ledgerEntries).toBe(1);
  });

  test("50 apostas de 1.00 concorrentes sobre saldo 30.00 -> exatamente 30 processadas, saldo final 0", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "30.00" });

    const submit = (i: number) =>
      ctx.run(() =>
        ctx.processWagerTransaction.execute({
          idempotencyKey: `provider-a:burst-${i}`,
          providerId: "provider-a",
          externalTransactionId: `burst-${i}`,
          playerId,
          walletId,
          roundId: "round-burst",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "1.00", currency: "BRL" },
        }),
      );

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(i)));
    const processedCount = results.filter((r) => r.status === WagerTransactionStatus.Processed).length;
    const rejectedCount = results.filter((r) => r.status === WagerTransactionStatus.Rejected).length;

    expect(processedCount).toBe(30);
    expect(rejectedCount).toBe(20);

    const finalWallet = await ctx.run(() => ctx.walletRepository.findById(walletId));
    expect(finalWallet?.balance.toJSON().amount).toBe("0.00");
  });

  test("a mesma aposta enviada 50 vezes em paralelo (mesma idempotency key) -> um único débito", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const submitSame = () =>
      ctx.run(() =>
        ctx.processWagerTransaction.execute({
          idempotencyKey: "provider-a:same-tx-parallel",
          providerId: "provider-a",
          externalTransactionId: "same-tx-parallel",
          playerId,
          walletId,
          roundId: "round-idempotent",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "25.00", currency: "BRL" },
        }),
      );

    const results = await Promise.all(Array.from({ length: 50 }, () => submitSame()));

    // todas devem devolver o MESMO transactionId
    const uniqueTransactionIds = new Set(results.map((r) => r.transactionId));
    expect(uniqueTransactionIds.size).toBe(1);

    const finalWallet = await ctx.run(() => ctx.walletRepository.findById(walletId));
    expect(finalWallet?.balance.toJSON().amount).toBe("75.00"); // debitou só uma vez
  });
});