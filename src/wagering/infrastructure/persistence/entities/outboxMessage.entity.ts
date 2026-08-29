import { defineEntity, p } from "@mikro-orm/postgresql";

export const OutboxMessageSchema = defineEntity({
  name: "OutboxMessage",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.string(),
    payload: p.json(),
    occurredAt: p.datetime(),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
  },
  indexes: [
    // pro publisher escanear só o que está pendente, sem varrer a tabela toda
    { name: "outbox_pending_idx", properties: ["occurredAt"], where: { publishedAt: null } },
  ],
  checks: [
    { name: "outbox_attempts_non_negative_ck", expression: (c) => `${c.attempts} >= 0` },
  ],
  // mesmo padrão do inbox: permite UMA transição (publishedAt NULL -> timestamp), bloqueia depois
  triggers: [
    {
      name: "outbox_no_mutate_after_published",
      timing: "before",
      events: ["update"],
      body: (c) =>
        `IF OLD.${c.publishedAt} IS NOT NULL THEN ` +
        `RAISE EXCEPTION 'mensagem % da outbox já foi publicada em %, não pode mais mudar', OLD.${c.id}, OLD.${c.publishedAt}; ` +
        `END IF; RETURN NEW;`,
    },
  ],
});

export class OutboxMessageEntity extends OutboxMessageSchema.class {}
OutboxMessageSchema.setClass(OutboxMessageEntity);