import { IntegrationEvent, type IntegrationEventProps } from "../integrationEvent";
import type { WagerTransaction, WagerTransactionKind } from "../wagerTransaction";
import type { EventContext } from "./eventContext";
import { getFailureCodeGuidance } from "../failureCode";
import type { FailureCode, RecommendedAction } from "../failureCode";

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  failureCode: FailureCode;
  recommendedAction: RecommendedAction;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!transaction.failureCode) {
      // invariante: reject() sempre exige um FailureCode — chegar aqui sem um é bug de chamada, não estado de negócio válido
      throw new Error(`WagerTransactionRejected.from: transação ${transaction.id} está REJECTED sem failureCode`);
    }
    return new WagerTransactionRejected({
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
        failureCode: transaction.failureCode,
        recommendedAction: getFailureCodeGuidance(transaction.failureCode).action,
      },
    });
  }
}