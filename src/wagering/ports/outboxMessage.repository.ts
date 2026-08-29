import { OutboxMessage } from "../domain/outboxMessage";

export abstract class OutboxMessageRepository {
  /** Só criação — dentro da mesma transação da mudança que originou o evento. */
  abstract create(message: OutboxMessage): Promise<void>;

  /** Busca um lote de mensagens pendentes e prontas (isDue), com SELECT ... FOR UPDATE SKIP LOCKED —
   * múltiplos workers concorrentes pegam lotes disjuntos, sem esperar uns pelos outros. */
  abstract findPendingBatch(limit: number): Promise<OutboxMessage[]>;

  /** Persiste markPublished()/scheduleRetry() numa mensagem já existente. */
  abstract save(message: OutboxMessage): Promise<void>;
}