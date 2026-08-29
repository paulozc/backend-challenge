import { test, expect, describe } from "bun:test";

import {
  InvalidTransactionError,
  InvalidTransactionStateError,
  MissingReferenceError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../wagerTransaction";

import { LedgerDirection } from "../../walletLedgerEntry";
import { Money } from "../../money";

const baseProps = {
  id: "t1",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  idempotencyKey: "provider-a:ext-1",
  payloadHash: "hash1",
  walletId: "w1",
  playerId: "p1",
  roundId: "round-1",
  gameId: "game-1",
  createdAt: new Date(),
};

describe("WagerTransaction.create — política de referência por kind", () => {
  test("nasce em PENDING", () => {
    const bet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
    });

    expect(bet.status).toBe(WagerTransactionStatus.Pending);
  });

  test("REFUND sem referenceExternalTransactionId lança MissingReferenceError", () => {
    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
      }),
    ).toThrow(MissingReferenceError);
  });

  test("BET com referenceExternalTransactionId é rejeitado (não faz sentido pra esse kind)", () => {
    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
        referenceExternalTransactionId: "ext-0",
      }),
    ).toThrow(InvalidTransactionError);
  });

  test("WIN com referenceExternalTransactionId é permitido (opcional)", () => {
    const win = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-1",
    });

    expect(win.status).toBe(WagerTransactionStatus.Pending);
  });
});

describe("WagerTransaction — transições de estado", () => {
  test("markProcessed move pra PROCESSED e registra processedAt", () => {
    const bet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
    });

    const at = new Date("2026-08-28T10:00:00.000Z");
    bet.markProcessed(undefined, at);

    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.processedAt?.getTime()).toBe(at.getTime());
    expect(bet.isTerminal()).toBe(true);
  });

  test("transicionar um estado terminal de novo lança InvalidTransactionStateError", () => {
    const bet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
    });

    bet.markProcessed(undefined, new Date());

    expect(() => bet.markProcessed(undefined, new Date())).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("PENDING_REFERENCE não é terminal e ainda pode transicionar", () => {
    const refund = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-1",
    });

    refund.markPendingReference();

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.isTerminal()).toBe(false);

    refund.reject("REFERENCE_NOT_FOUND");

    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
  });
});

describe("WagerTransaction.ledgerDirectionFor", () => {
  test("BET vira DEBIT, WIN e REFUND viram CREDIT", () => {
    const bet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
    });
    const win = WagerTransaction.create({
      ...baseProps,
      id: "t2",
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
    });
    const refund = WagerTransaction.create({
      ...baseProps,
      id: "t3",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-1",
    });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverte a direção da transação referenciada", () => {
    const bet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
    });
    const win = WagerTransaction.create({
      ...baseProps,
      id: "t2",
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
    });

    const rollbackOfBet = WagerTransaction.create({
      ...baseProps,
      id: "t3",
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-1",
    });
    const rollbackOfWin = WagerTransaction.create({
      ...baseProps,
      id: "t4",
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: "50.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-2",
    });

    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollbackOfWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test("LOSS não tem direção de ledger", () => {
    const loss = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
    });

    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(loss.affectsBalance()).toBe(false);
  });
});

describe("WagerTransaction.matchesPayload", () => {
  test("mesmo hash retorna true, hash diferente retorna false (base da idempotência)", () => {
    const bet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
    });

    expect(bet.matchesPayload("hash1")).toBe(true);
    expect(bet.matchesPayload("hash-diferente")).toBe(false);
  });
});