/**
 * Contexto compartilhado ao criar um evento de integração. `eventId` é único por evento;
 * `correlationId` amarra todos os eventos de uma mesma execução de use case — por
 * enquanto, usamos o id da própria WagerTransaction (ainda não temos um id de
 * requisição/mensagem de entrada vindo da camada HTTP/SQS pra propagar aqui; revisitar
 * quando essa camada existir).
 */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}