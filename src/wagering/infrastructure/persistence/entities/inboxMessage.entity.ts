import { defineEntity, p } from "@mikro-orm/postgresql";

export const InboxMessageSchema = defineEntity({
  name: "InboxMessage",
  tableName: "inbox_messages",
  properties: {
    messageId: p.string().primary(),
    consumerName: p.string().primary(),
    payloadHash: p.string(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
  checks: [
    {
      name: "inbox_processed_after_received_ck",
      expression: (c) => `${c.processedAt} IS NULL OR ${c.processedAt} >= ${c.receivedAt}`,
    },
  ],
  // imutabilidade parcial: permite UMA transição (processedAt NULL -> timestamp), bloqueia reprocessar.
  // diferente do trigger do ledger (bloqueia tudo, sempre) — aqui a condição olha o OLD.
  triggers: [
    {
      name: "inbox_no_reprocess",
      timing: "before",
      events: ["update"],
      body: (c) =>
        `IF OLD.${c.processedAt} IS NOT NULL THEN ` +
        `RAISE EXCEPTION 'mensagem %/% já foi processada em %', OLD.${c.messageId}, OLD.${c.consumerName}, OLD.${c.processedAt}; ` +
        `END IF; RETURN NEW;`,
    },
  ],
});

export class InboxMessageEntity extends InboxMessageSchema.class {}
InboxMessageSchema.setClass(InboxMessageEntity);