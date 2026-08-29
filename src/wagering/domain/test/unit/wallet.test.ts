import { test, expect, describe } from "bun:test";

import {
  InsufficientFundsError,
  Wallet,
} from "../../wallet";

import { CurrencyMismatchError, Money } from "../../money";

describe("Wallet.open", () => {
  test("abre com o saldo inicial e version 1", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    expect(wallet.balance.toJSON()).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet.debit / Wallet.credit", () => {
  test("débito válido reduz o saldo e incrementa a version", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    const at = new Date("2026-08-28T10:00:00.000Z");
    const entry = wallet.debit({
      entryId: "e1",
      transactionId: "t1",
      money: Money.from({
        amount: "25.00",
        currency: "BRL",
      }),
      at,
    });

    expect(wallet.balance.toJSON().amount).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.updatedAt.getTime()).toBe(at.getTime());
  });

  test("crédito válido aumenta o saldo e incrementa a version", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    wallet.credit({
      entryId: "e1",
      transactionId: "t1",
      money: Money.from({
        amount: "10.00",
        currency: "BRL",
      }),
      at: new Date(),
    });

    expect(wallet.balance.toJSON().amount).toBe("110.00");
    expect(wallet.version).toBe(2);
  });

  test("débito que causaria saldo negativo não muda nenhum estado (tudo ou nada)", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({
        amount: "50.00",
        currency: "BRL",
      }),
    });

    const versionBefore = wallet.version;

    expect(() =>
      wallet.debit({
        entryId: "e1",
        transactionId: "t1",
        money: Money.from({
          amount: "999.00",
          currency: "BRL",
        }),
        at: new Date(),
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.toJSON().amount).toBe("50.00");
    expect(wallet.version).toBe(versionBefore);
  });

  test("débito em moeda diferente da wallet lança CurrencyMismatchError", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    expect(() =>
      wallet.debit({
        entryId: "e1",
        transactionId: "t1",
        money: Money.from({
          amount: "1.00",
          currency: "USD",
        }),
        at: new Date(),
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe("Wallet — cenário obrigatório (seção 8)", () => {
  test("de duas apostas de 80 sobre saldo 100, só uma é aceita", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    });

    wallet.debit({
      entryId: "e1",
      transactionId: "t1",
      money: Money.from({
        amount: "80.00",
        currency: "BRL",
      }),
      at: new Date(),
    });

    expect(() =>
      wallet.debit({
        entryId: "e2",
        transactionId: "t2",
        money: Money.from({
          amount: "80.00",
          currency: "BRL",
        }),
        at: new Date(),
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2); // a aposta rejeitada não incrementa version

    // NOTA: isso prova a regra de negócio em sequência, dentro de um processo só.
    // A prova com 2+ instâncias reais e SELECT ... FOR UPDATE é teste de integração,
    // feito contra Postgres de verdade — não aqui.
  });
});