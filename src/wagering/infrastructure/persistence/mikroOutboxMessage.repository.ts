import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/outboxMessage";
import { OutboxMessageRepository } from "../../ports/outboxMessage.repository";
import { OutboxMessageEntity } from "./entities/outboxMessage.entity";
import { outboxMessageToEntityData } from "./outboxMessage.mapper";

@Injectable()
export class MikroOutboxMessageRepository extends OutboxMessageRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async create(message: OutboxMessage): Promise<void> {
    this.em.create(OutboxMessageEntity, outboxMessageToEntityData(message));
    await this.em.flush();
  }
}