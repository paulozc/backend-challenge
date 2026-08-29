import { Injectable, Logger } from "@nestjs/common";
import { InboxMessageRepository } from "../../ports/inboxMessage.repository";
import { UnitOfWork } from "../../ports/unitOfWork";
import { InboxMessage } from "../../domain/inboxMessage";
import {
  ProcessWagerTransactionUseCase,
  WalletNotFoundError,
  IdempotencyConflictError,
  UnsupportedKindError,
} from "../../application/processWagerTransaction.useCase";
import { computePayloadHash } from "../../application/payloadHash";

export const WAGER_TRANSACTIONS_CONSUMER_NAME = "wager-transactions-consumer";

export type MessageOutcome = "ack" | "retry";

interface WagerTransactionRequestedMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

@Injectable()
export class WagerTransactionMessageHandler {
  private readonly logger = new Logger(WagerTransactionMessageHandler.name);

  constructor(
    private readonly inboxMessageRepository: InboxMessageRepository,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  /**
   * @param sqsMessageId o MessageId nativo do SQS (não o "messageId" de dentro do corpo) —
   * é o que permanece igual entre redeliveries da mesma mensagem física.
   */
  async handle(sqsMessageId: string, rawBody: string): Promise<MessageOutcome> {
    const existingInbox = await this.inboxMessageRepository.findByMessageIdAndConsumer(
      sqsMessageId,
      WAGER_TRANSACTIONS_CONSUMER_NAME,
    );
    if (existingInbox?.isProcessed()) {
      this.logger.debug(`mensagem ${sqsMessageId} já processada — ack sem reprocessar`);
      return "ack";
    }

    let parsed: WagerTransactionRequestedMessage;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.logger.error(`mensagem ${sqsMessageId} não é JSON válido — terminal, ack`);
      await this.markInboxProcessed(sqsMessageId, existingInbox, "invalid-json");
      return "ack";
    }

    const payloadHash = computePayloadHash(parsed.data as unknown as Record<string, unknown>);

    try {
      await this.processWagerTransaction.execute({
        idempotencyKey: parsed.data.idempotencyKey,
        providerId: parsed.data.providerId,
        externalTransactionId: parsed.data.externalTransactionId,
        playerId: parsed.data.playerId,
        walletId: parsed.data.walletId,
        roundId: parsed.data.roundId,
        gameId: parsed.data.gameId,
        kind: parsed.data.kind as never,
        money: parsed.data.money,
        referenceExternalTransactionId: parsed.data.referenceExternalTransactionId,
      });
    } catch (err) {
      if (this.isTerminalBusinessError(err)) {
        this.logger.warn(`mensagem ${sqsMessageId} — erro de negócio terminal: ${(err as Error).message}`);
        // segue pro ack — redelivery não ajudaria, o erro é determinístico
      } else {
        this.logger.error(`mensagem ${sqsMessageId} — erro transitório/inesperado: ${(err as Error).message}`);
        return "retry"; // não marca inbox, não faz ack — deixa o SQS redeliverar
      }
    }

    // Marca a inbox DEPOIS que o use case terminou. Ver ARCHITECTURE.md: essa marcação
    // não fica na MESMA transação SQL da mudança financeira (limitação real testada do
    // MikroORM com transactional() aninhado) — mas é segura porque a idempotencyKey da
    // própria WagerTransaction já protege contra reprocessamento duplicado nessa janela.
    await this.markInboxProcessed(sqsMessageId, existingInbox, payloadHash);
    return "ack";
  }

  private async markInboxProcessed(
    sqsMessageId: string,
    existingInbox: InboxMessage | null,
    payloadHash: string,
  ): Promise<void> {
    await this.unitOfWork.transactional(async () => {
      const inbox =
        existingInbox ??
        InboxMessage.receive({
          messageId: sqsMessageId,
          consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
          payloadHash,
          receivedAt: new Date(),
        });
      inbox.markProcessed(new Date());
      await this.inboxMessageRepository.save(inbox);
    });
  }

  private isTerminalBusinessError(err: unknown): boolean {
    return (
      err instanceof WalletNotFoundError ||
      err instanceof IdempotencyConflictError ||
      err instanceof UnsupportedKindError
    );
  }
}