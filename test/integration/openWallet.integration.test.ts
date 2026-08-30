import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionStatus } from "../../src/wagering/domain/wagerTransaction";
import { WalletAlreadyExistsError } from "../../src/wagering/application/openWallet.useCase";
import { setupIntegrationTest, teardownIntegrationTest, type IntegrationTestContext } from "./testSetup";

describe("OpenWalletUseCase", () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await setupIntegrationTest();
  });

  afterAll(async () => {
    await teardownIntegrationTest(ctx);
  });

  test("abrir com saldo inicial positivo cria a wallet, a transação OPENING e o lançamento CREDIT", async () => {
    const playerId = randomUUID();

    const result = await ctx.run(() =>
      ctx.openWallet.execute({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } }),
    );

    expect(result.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    // version fica 1, não 2 — Wallet.open() já define o saldo final na criação,
    // não passa por wallet.credit() (ver ARCHITECTURE.md, decisão registrada)
    expect(result.version).toBe(1);

    const openingTx = await ctx.run(() =>
      ctx.wagerTransactionRepository.findByProviderAndExternalId("internal", `opening-${result.id}`),
    );
    expect(openingTx?.status).toBe(WagerTransactionStatus.Processed);

    const entry = await ctx.run(() => ctx.walletLedgerEntryRepository.findByTransactionId(openingTx!.id));
    expect(entry?.balanceAfter.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
  });

  test("abrir com saldo ZERO não gera transação OPENING nem lançamento", async () => {
    const playerId = randomUUID();

    const result = await ctx.run(() =>
      ctx.openWallet.execute({ playerId, initialBalance: { amount: "0.00", currency: "BRL" } }),
    );

    const openingTx = await ctx.run(() =>
      ctx.wagerTransactionRepository.findByProviderAndExternalId("internal", `opening-${result.id}`),
    );
    expect(openingTx).toBeNull();
  });

  test("segunda wallet pro mesmo playerId + currency é rejeitada", async () => {
    const playerId = randomUUID();
    await ctx.run(() => ctx.openWallet.execute({ playerId, initialBalance: { amount: "10.00", currency: "BRL" } }));

    await expect(
      ctx.run(() => ctx.openWallet.execute({ playerId, initialBalance: { amount: "5.00", currency: "BRL" } })),
    ).rejects.toThrow(WalletAlreadyExistsError);
  });

  test("mesmo playerId, moeda diferente, funciona normalmente", async () => {
    const playerId = randomUUID();
    await ctx.run(() => ctx.openWallet.execute({ playerId, initialBalance: { amount: "10.00", currency: "BRL" } }));

    const result = await ctx.run(() =>
      ctx.openWallet.execute({ playerId, initialBalance: { amount: "20.00", currency: "USD" } }),
    );
    expect(result.balance.currency).toBe("USD");
  });
});