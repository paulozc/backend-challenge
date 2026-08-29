import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { InboxMessage } from "../../domain/inboxMessage";
import { InboxMessageRepository } from "../../ports/inboxMessage.repository";
import { InboxMessageEntity } from "./entities/inboxMessage.entity";
import { inboxMessageToDomain, inboxMessageToEntityData, applyInboxMessageToEntity } from "./inboxMessage.mapper";

@Injectable()
export class MikroInboxMessageRepository extends InboxMessageRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findByMessageIdAndConsumer(messageId: string, consumerName: string): Promise<InboxMessage | null> {
    const entity = await this.em.findOne(InboxMessageEntity, { messageId, consumerName });
    return entity ? inboxMessageToDomain(entity) : null;
  }

  async save(message: InboxMessage): Promise<void> {
    const entity = await this.em.findOne(InboxMessageEntity, {
      messageId: message.messageId,
      consumerName: message.consumerName,
    });
    if (entity) {
      applyInboxMessageToEntity(message, entity);
    } else {
      this.em.create(InboxMessageEntity, inboxMessageToEntityData(message));
    }
    await this.em.flush();
  }
}