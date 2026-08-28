import { test, expect, describe } from "bun:test";

import {
  LedgerEntryUnbalancedError,
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from "../../walletLedgerEntry";

import { Money } from "../../money";

describe("WalletLedgerEntry.create", () => {
  test("lançamento com aritmética errada é rejeitado na criação", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "e1",
        walletId: "w1",
        transactionId: "t1",
        direction: LedgerDirection.Debit,
        money: Money.from({
          amount: "25.00",
          currency: "BRL",
        }),
        balanceBefore: Money.from({
          amount: "100.00",
          currency: "BRL",
        }),
        balanceAfter: Money.from({
          amount: "80.00",
          currency: "BRL",
        }),
        createdAt: new Date(),
      }),
    ).toThrow(LedgerEntryUnbalancedError);
  });

  test("money zero é rejeitado", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "e1",
        walletId: "w1",
        transactionId: "t1",
        direction: LedgerDirection.Credit,
        money: Money.zero("BRL"),
        balanceBefore: Money.from({
          amount: "20.00",
          currency: "BRL",
        }),
        balanceAfter: Money.from({
          amount: "20.00",
          currency: "BRL",
        }),
        createdAt: new Date(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});