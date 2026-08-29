import { InboxMessage } from "../domain/inboxMessage";

export abstract class InboxMessageRepository {
  abstract findByMessageIdAndConsumer(messageId: string, consumerName: string): Promise<InboxMessage | null>;

  /** Cria se ainda não existe, atualiza (markProcessed) se já existe. */
  abstract save(message: InboxMessage): Promise<void>;
}