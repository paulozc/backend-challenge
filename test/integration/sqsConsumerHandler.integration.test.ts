import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionKind } from "../../src/wagering/domain/wagerTransaction";
import { WAGER_TRANSACTIONS_CONSUMER_NAME } from "../../src/wagering/infrastructure/messaging/wagerTransactionMessage.handler";
import { setupIntegrationTest, teardownIntegrationTest, seedWallet, type IntegrationTestContext } from "./testSetup";

function makeMessageBody(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    messageId: randomUUID(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: randomUUID(),
      idempotencyKey: `provider-a:${randomUUID()}`,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
      ...dataOverrides,
    },
    ...overrides,
  });
}

describe("WagerTransactionMessageHandler (consumidor SQS)", () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await setupIntegrationTest();
  });

  afterAll(async () => {
    await teardownIntegrationTest(ctx);
  });

  test("mensagem nova é processada, a inbox é marcada, e o saldo é debitado", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const sqsMessageId = randomUUID();
    const externalTransactionId = randomUUID();
    const body = makeMessageBody({}, {
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId, walletId,
    });

    const outcome = await ctx.run(() => ctx.wagerTransactionMessageHandler.handle(sqsMessageId, body));
    expect(outcome).toBe("ack");

    const wallet = await ctx.run(() => ctx.walletRepository.findById(walletId));
    expect(wallet?.balance.toJSON().amount).toBe("90.00");

    const inbox = await ctx.run(() => ctx.inboxMessageRepository.findByMessageIdAndConsumer(sqsMessageId, WAGER_TRANSACTIONS_CONSUMER_NAME));
    expect(inbox?.isProcessed()).toBe(true);
  });

  test("a MESMA sqsMessageId de novo (redelivery) não reprocessa — saldo intacto", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const sqsMessageId = randomUUID();
    const externalTransactionId = randomUUID();
    const body = makeMessageBody({}, {
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId, walletId,
    });

    await ctx.run(() => ctx.wagerTransactionMessageHandler.handle(sqsMessageId, body));
    const outcome = await ctx.run(() => ctx.wagerTransactionMessageHandler.handle(sqsMessageId, body));
    expect(outcome).toBe("ack");

    const wallet = await ctx.run(() => ctx.walletRepository.findById(walletId));
    expect(wallet?.balance.toJSON().amount).toBe("90.00"); // não debitou de novo
  });

  test("cenário crítico: crash simulado entre o use case e a marcação da inbox — a idempotencyKey protege contra duplicação", async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await seedWallet(ctx, { id: walletId, playerId, currency: "BRL", balance: "100.00" });

    const externalTransactionId = randomUUID();
    const idempotencyKey = `provider-a:${externalTransactionId}`;

    // simula o "crash": chama o use case DIRETO (não o handler), deixando a inbox sem marcar
    await ctx.run(() =>
      ctx.processWagerTransaction.execute({
        idempotencyKey, providerId: "provider-a", externalTransactionId,
        playerId, walletId, roundId: "round-1", gameId: "game-1",
        kind: WagerTransactionKind.Bet, money: { amount: "10.00", currency: "BRL" },
      }),
    );

    const walletBeforeRedelivery = await ctx.run(() => ctx.walletRepository.findById(walletId));

    // "redelivery" pós-crash: o handler recebe a mensagem, mas a inbox nunca foi marcada
    const sqsMessageId = randomUUID();
    const body = makeMessageBody({}, { externalTransactionId, idempotencyKey, playerId, walletId });
    const outcome = await ctx.run(() => ctx.wagerTransactionMessageHandler.handle(sqsMessageId, body));
    expect(outcome).toBe("ack");

    const walletAfterRedelivery = await ctx.run(() => ctx.walletRepository.findById(walletId));
    expect(walletAfterRedelivery?.balance.toJSON().amount).toBe(walletBeforeRedelivery?.balance.toJSON().amount);

    const inbox = await ctx.run(() => ctx.inboxMessageRepository.findByMessageIdAndConsumer(sqsMessageId, WAGER_TRANSACTIONS_CONSUMER_NAME));
    expect(inbox?.isProcessed()).toBe(true); // inbox foi "curada" nessa segunda tentativa
  });

  test("erro de negócio terminal (wallet inexistente) -> ack, não retry", async () => {
    const playerId = randomUUID();
    const externalTransactionId = randomUUID();
    const body = makeMessageBody({}, {
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId,
      walletId: randomUUID(), // não existe
    });

    const outcome = await ctx.run(() => ctx.wagerTransactionMessageHandler.handle(randomUUID(), body));
    expect(outcome).toBe("ack");
  });

  test("erro inesperado/transitório (walletId malformado) -> retry, inbox não é tocada", async () => {
    const playerId = randomUUID();
    const externalTransactionId = randomUUID();
    const body = makeMessageBody({}, {
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId,
      walletId: "isso-nao-e-um-uuid",
    });

    const sqsMessageId = randomUUID();
    const outcome = await ctx.run(() => ctx.wagerTransactionMessageHandler.handle(sqsMessageId, body));
    expect(outcome).toBe("retry");

    const inbox = await ctx.run(() => ctx.inboxMessageRepository.findByMessageIdAndConsumer(sqsMessageId, WAGER_TRANSACTIONS_CONSUMER_NAME));
    expect(inbox).toBeNull();
  });
});