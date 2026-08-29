import { OutboxMessage } from "../domain/outboxMessage";

export abstract class EventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
}