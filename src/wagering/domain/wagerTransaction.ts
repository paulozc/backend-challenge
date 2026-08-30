import { Money } from "./money";
import { LedgerDirection } from "./walletLedgerEntry";
import type { FailureCode } from "./failureCode";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

// taxonomia formal em ./failureCode.ts (seção 7.2)

// backoff do worker de reprocessamento de PENDING_REFERENCE (seção 7.1) — 5s, 10s, 20s,
// 40s, 80s, ~2.7min, ~5.3min, 10min(teto) = ~20min de janela total antes de desistir
const REFERENCE_RETRY_BASE_MS = 5_000;
const REFERENCE_RETRY_MAX_MS = 10 * 60 * 1000;

interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  referenceRetryAttempts?: number;
  nextReferenceRetryAt?: Date;
}

export class MissingReferenceError extends Error {}
export class InvalidTransactionError extends Error {}
export class InvalidTransactionStateError extends Error {}

type ReferencePolicy = "required" | "optional" | "forbidden";

function referencePolicyFor(kind: WagerTransactionKind): ReferencePolicy {
  if (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) return "required";
  if (kind === WagerTransactionKind.Win) return "optional";
  return "forbidden";
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _referenceRetryAttempts: number = 0,
    private _nextReferenceRetryAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const policy = referencePolicyFor(props.kind);
    if (policy === "required" && !props.referenceExternalTransactionId) {
      throw new MissingReferenceError(`${props.kind} exige referenceExternalTransactionId`);
    }
    if (policy === "forbidden" && props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${props.kind} não aceita referenceExternalTransactionId`);
    }
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey, props.payloadHash,
      props.walletId, props.playerId, props.roundId, props.gameId, props.kind, props.money,
      props.referenceExternalTransactionId, props.createdAt,
      WagerTransactionStatus.Pending, undefined, undefined, undefined, 0, undefined,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId, state.idempotencyKey, state.payloadHash,
      state.walletId, state.playerId, state.roundId, state.gameId, state.kind, state.money,
      state.referenceExternalTransactionId, state.createdAt,
      state.status, state.referenceTransactionId, state.failureCode, state.processedAt,
      state.referenceRetryAttempts ?? 0, state.nextReferenceRetryAt,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  get referenceRetryAttempts(): number { return this._referenceRetryAttempts; }
  get nextReferenceRetryAt(): Date | undefined { return this._nextReferenceRetryAt; }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`transação ${this.id} já está em estado terminal (${this._status})`);
    }
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
  }

  /**
   * Chamado pelo worker de reprocessamento (seção 7.1) quando tenta resolver a
   * referência de novo mas ela ainda não chegou. Mesmo formato de backoff exponencial
   * já usado em OutboxMessage.scheduleRetry(), mas com base maior (5s) e teto maior
   * (10min) — justificativa: esperar uma transação relacionada do MESMO provider
   * chegar pode legitimamente levar mais tempo que republicar um evento de integração,
   * já que depende de todo o pipeline de entrega do provider, não só do nosso outbox.
   */
  scheduleReferenceRetry(now: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `só é possível reagendar retry de referência em PENDING_REFERENCE (atual: ${this._status})`,
      );
    }
    this._referenceRetryAttempts += 1;
    const backoffMs = Math.min(2 ** this._referenceRetryAttempts * REFERENCE_RETRY_BASE_MS, REFERENCE_RETRY_MAX_MS);
    this._nextReferenceRetryAt = new Date(now.getTime() + backoffMs);
  }

  /** true se ainda não passou do limite de tentativas — usado pelo worker pra decidir entre reagendar ou desistir. */
  hasReferenceRetriesLeft(maxAttempts: number): boolean {
    return this._referenceRetryAttempts < maxAttempts;
  }

  isReferenceRetryDue(now: Date): boolean {
    if (this._status !== WagerTransactionStatus.PendingReference) return false;
    if (!this._nextReferenceRetryAt) return true; // nunca tentou de novo — pronta pra primeira tentativa do worker
    return this._nextReferenceRetryAt.getTime() <= now.getTime();
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.Processed
      || this._status === WagerTransactionStatus.Rejected
      || this._status === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionError("ROLLBACK precisa da transação referenciada para determinar a direção");
        }
        const refDirection = reference.ledgerDirectionFor();
        return refDirection === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError("LOSS não afeta saldo, não tem direção de ledger");
    }
  }
}