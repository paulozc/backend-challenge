// outbox-message.ts
import { IntegrationEvent } from "./integrationEvent";

interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxAlreadyPublishedError extends Error {}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(event.eventId, event.aggregateId, envelope.eventType, envelope, event.occurredAt, 0, undefined, undefined);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state.id, state.aggregateId, state.eventType, state.payload, state.occurredAt, state.attempts, state.nextAttemptAt, state.publishedAt);
  }

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (this._nextAttemptAt === undefined) return true; // nunca tentou -> pronta pra primeira tentativa
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new OutboxAlreadyPublishedError(`mensagem ${this.id} já publicada em ${this._publishedAt}`);
    }
    this._publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new OutboxAlreadyPublishedError(`mensagem ${this.id} já publicada, sem retry`);
    }
    this._attempts += 1;
    const backoffMs = Math.min(2 ** this._attempts * BASE_BACKOFF_MS, MAX_BACKOFF_MS);
    this._nextAttemptAt = new Date(now.getTime() + backoffMs);
  }
}