import { OutboxMessage } from "../domain/outboxMessage";

export abstract class OutboxMessageRepository {
  /** Só criação — dentro da mesma transação da mudança que originou o evento. */
  abstract create(message: OutboxMessage): Promise<void>;
}