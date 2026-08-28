import { Money, CurrencyMismatchError } from "./money";
import { WalletLedgerEntry, LedgerDirection } from "./walletLedgerEntry";

interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date; // injetado, não new Date() interno — mesmo "agora" do use case inteiro
}

export class InsufficientFundsError extends Error {}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    const now = new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(`${this.currency} != ${money.currency}`);
    }
  }

  private applyMovement(direction: LedgerDirection, props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    const balanceBefore = this._balance;
    const balanceAfter = direction === LedgerDirection.Debit
      ? balanceBefore.subtract(props.money)
      : balanceBefore.add(props.money);

    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(`saldo insuficiente: ${balanceBefore} ${direction} ${props.money}`);
    }

    // se qualquer coisa aqui falhar, a linha abaixo nunca roda — nada muda
    const entry = WalletLedgerEntry.create({
      id: props.entryId, walletId: this.id, transactionId: props.transactionId,
      direction, money: props.money, balanceBefore, balanceAfter, createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    return this.applyMovement(LedgerDirection.Debit, props);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    return this.applyMovement(LedgerDirection.Credit, props);
  }
}