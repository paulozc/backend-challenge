import { InboxMessage } from "../../domain/inboxMessage";
import { InboxMessageEntity } from "./entities/inboxMessage.entity";

/** DB (via MikroORM) -> domínio. Usa InboxMessage.rehydrate() — não revalida. */
export function inboxMessageToDomain(entity: InboxMessageEntity): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: entity.messageId,
    consumerName: entity.consumerName,
    payloadHash: entity.payloadHash,
    receivedAt: entity.receivedAt,
    processedAt: entity.processedAt ?? undefined,
  });
}

/** domínio -> dado pra criar uma linha nova (usar com em.create(InboxMessageEntity, ...)). */
export function inboxMessageToEntityData(inbox: InboxMessage) {
  return {
    messageId: inbox.messageId,
    consumerName: inbox.consumerName,
    payloadHash: inbox.payloadHash,
    receivedAt: inbox.receivedAt,
    processedAt: inbox.processedAt ?? null,
  };
}

/** domínio -> DB: aplica markProcessed() numa entidade já rastreada. */
export function applyInboxMessageToEntity(inbox: InboxMessage, entity: InboxMessageEntity): void {
  entity.processedAt = inbox.processedAt ?? null;
}