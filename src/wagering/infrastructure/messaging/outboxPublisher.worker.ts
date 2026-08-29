import { Injectable, Logger } from "@nestjs/common";
import { OutboxMessageRepository } from "../../ports/outboxMessage.repository";
import { EventPublisher } from "../../ports/eventPublisher";
import { UnitOfWork } from "../../ports/unitOfWork";

@Injectable()
export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);

  constructor(
    private readonly outboxMessageRepository: OutboxMessageRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  /**
   * Processa um lote de mensagens pendentes. Retorna quantas foram processadas
   * (0 = nada pendente no momento) — usado tanto pelos testes quanto pelo loop de
   * polling pra decidir se espera antes da próxima tentativa.
   */
  async pollOnce(batchSize = 10): Promise<number> {
    return this.unitOfWork.transactional(async () => {
      const batch = await this.outboxMessageRepository.findPendingBatch(batchSize);

      for (const message of batch) {
        try {
          await this.eventPublisher.publish(message);
          message.markPublished(new Date());
        } catch (err) {
          this.logger.warn(`falha ao publicar mensagem ${message.id} (${message.eventType}): ${(err as Error).message}`);
          message.scheduleRetry(new Date());
        }
        await this.outboxMessageRepository.save(message);
      }

      return batch.length;
    });
  }
}