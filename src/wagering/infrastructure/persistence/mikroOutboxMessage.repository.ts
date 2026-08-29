import { Injectable } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/outboxMessage";
import { OutboxMessageRepository } from "../../ports/outboxMessage.repository";
import { OutboxMessageEntity } from "./entities/outboxMessage.entity";
import { outboxMessageToEntityData, outboxMessageToDomain, applyOutboxMessageToEntity } from "./outboxMessage.mapper";

@Injectable()
export class MikroOutboxMessageRepository extends OutboxMessageRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async create(message: OutboxMessage): Promise<void> {
    this.em.create(OutboxMessageEntity, outboxMessageToEntityData(message));
    await this.em.flush();
  }

  async findPendingBatch(limit: number): Promise<OutboxMessage[]> {
    const now = new Date();
    const entities = await this.em.find(
      OutboxMessageEntity,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        orderBy: { occurredAt: "asc" },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // gera "for update skip locked"
      },
    );
    return entities.map(outboxMessageToDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    const entity = await this.em.findOneOrFail(OutboxMessageEntity, { id: message.id });
    applyOutboxMessageToEntity(message, entity);
    await this.em.flush();
  }
}