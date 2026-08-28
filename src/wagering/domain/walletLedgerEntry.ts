import { Money, CurrencyMismatchError } from "./money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;           // sempre magnitude positiva — a direção já diz o sinal
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {}

export class InvalidLedgerEntryError extends Error {}
export class LedgerEntryUnbalancedError extends Error {}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        "o valor do lançamento deve ser positivo (a direção já indica débito/crédito)",
      );
    }
    if (props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("balanceAfter não pode ser negativo");
    }

    const entry = new WalletLedgerEntry(
      props.id, props.walletId, props.transactionId, props.direction,
      props.money, props.balanceBefore, props.balanceAfter, props.createdAt,
    );

    if (!entry.isBalanced()) {
      throw new LedgerEntryUnbalancedError(
        `lançamento desbalanceado: ${props.balanceBefore} ${props.direction} ${props.money} != ${props.balanceAfter}`,
      );
    }

    return entry;
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id, state.walletId, state.transactionId, state.direction,
      state.money, state.balanceBefore, state.balanceAfter, state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}