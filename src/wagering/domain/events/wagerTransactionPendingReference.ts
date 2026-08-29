import { IntegrationEvent, type IntegrationEventProps } from "../integrationEvent";
import type { WagerTransaction, WagerTransactionKind } from "../wagerTransaction";
import type { EventContext } from "./eventContext";

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        kind: transaction.kind,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? "",
      },
    });
  }
}