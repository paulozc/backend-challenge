import { Injectable, Logger } from "@nestjs/common";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { EventPublisher } from "../../ports/eventPublisher";
import { OutboxMessage } from "../../domain/outboxMessage";

/**
 * Fila de eventos de integração SAÍDA (WagerTransactionProcessed, WalletBalanceChanged...).
 * Diferente de "wager-transactions.fifo" (seção 10), que é ENTRADA de requisições dos
 * provedores — o desafio não nomeia uma fila específica pra eventos de saída, então
 * introduzimos uma própria. Documentado no ARCHITECTURE.md.
 */
@Injectable()
export class SqsEventPublisher extends EventPublisher {
  private readonly logger = new Logger(SqsEventPublisher.name);
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor() {
    super();
    this.client = new SQSClient({
      endpoint: process.env.SQS_ENDPOINT,
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
    this.queueUrl = process.env.WAGERING_EVENTS_QUEUE_URL ?? "";
  }

  async publish(message: OutboxMessage): Promise<void> {
    if (!this.queueUrl) {
      throw new Error("WAGERING_EVENTS_QUEUE_URL não configurada");
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        // explícito, não ContentBasedDeduplication — decisão já registrada no
        // ARCHITECTURE.md (a garantia real de dedup é a inbox, não a janela de 5min do SQS)
        MessageDeduplicationId: message.id,
        // agrupa por wallet — mantém ordem relativa dos eventos da MESMA wallet,
        // sem serializar eventos de wallets diferentes entre si
        MessageGroupId: message.aggregateId,
      }),
    );
    this.logger.debug(`publicado: ${message.eventType} (${message.id})`);
  }
}