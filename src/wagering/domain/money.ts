import { Decimal } from "decimal.js";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^\d+\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class InvalidMoneyError extends Error {}
export class CurrencyMismatchError extends Error {}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError(`moeda inválida: "${props.currency}"`);
    }
    if (typeof props.amount !== "string" || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`amount inválido: "${props.amount}"`);
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`${this.currency} != ${other.currency}`);
    }
  }

  // sua vez a partir daqui 👇
  add(other: Money): Money { 
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money { return new Money(this.value.negated(), this.currency);

  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }
  toString(): string {
    return `${this.currency} ${this.value.toFixed(2)}`;
  }
}