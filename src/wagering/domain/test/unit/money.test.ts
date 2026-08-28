import { test, expect, describe } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError, Money } from "../../money";

describe("Money", () => {
  test("aceita valor válido", () => {
    const m = Money.from({
      amount: "25.00",
      currency: "BRL",
    });

    expect(m.toJSON()).toEqual({
      amount: "25.00",
      currency: "BRL",
    });
  });

  test("rejeita mais de 2 casas decimais", () => {
    expect(() =>
      Money.from({
        amount: "25.001",
        currency: "BRL",
      }),
    ).toThrow(InvalidMoneyError);
  });

  test("subtract pode gerar negativo internamente", () => {
    const result = Money.from({
      amount: "80.00",
      currency: "BRL",
    }).subtract(
      Money.from({
        amount: "100.00",
        currency: "BRL",
      }),
    );

    expect(result.toJSON().amount).toBe("-20.00");
  });

  test("zero não é positivo nem negativo", () => {
    const zero = Money.zero("BRL");

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  test("equals entre moedas diferentes retorna false", () => {
    const brl = Money.from({
      amount: "80.00",
      currency: "BRL",
    });

    const usd = Money.from({
      amount: "80.00",
      currency: "USD",
    });

    expect(brl.equals(usd)).toBe(false);
  });

  test("isLessThan entre moedas diferentes lança erro", () => {
    const brl = Money.from({
      amount: "80.00",
      currency: "BRL",
    });

    const usd = Money.from({
      amount: "80.00",
      currency: "USD",
    });

    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});