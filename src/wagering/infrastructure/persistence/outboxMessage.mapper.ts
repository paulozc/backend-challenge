import { OutboxMessage } from "../../domain/outboxMessage";
import { OutboxMessageEntity } from "./entities/outboxMessage.entity";

/** DB (via MikroORM) -> domínio. Usa OutboxMessage.rehydrate() — não revalida. */
export function outboxMessageToDomain(entity: OutboxMessageEntity): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: entity.id,
    aggregateId: entity.aggregateId,
    eventType: entity.eventType,
    payload: entity.payload as Readonly<Record<string, unknown>>,
    occurredAt: entity.occurredAt,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt ?? undefined,
    publishedAt: entity.publishedAt ?? undefined,
  });
}

/** domínio -> dado pra criar uma linha nova (usar com em.create(OutboxMessageEntity, ...)). */
export function outboxMessageToEntityData(outbox: OutboxMessage) {
  return {
    id: outbox.id,
    aggregateId: outbox.aggregateId,
    eventType: outbox.eventType,
    payload: outbox.payload,
    occurredAt: outbox.occurredAt,
    attempts: outbox.attempts,
    nextAttemptAt: outbox.nextAttemptAt ?? null,
    publishedAt: outbox.publishedAt ?? null,
  };
}

/** domínio -> DB: aplica scheduleRetry()/markPublished() numa entidade já rastreada. */
export function applyOutboxMessageToEntity(outbox: OutboxMessage, entity: OutboxMessageEntity): void {
  entity.attempts = outbox.attempts;
  entity.nextAttemptAt = outbox.nextAttemptAt ?? null;
  entity.publishedAt = outbox.publishedAt ?? null;
}