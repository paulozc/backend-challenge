import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { MikroORM, EntityManager, RequestContext } from "@mikro-orm/postgresql";

import { WalletEntity } from "../../src/wagering/infrastructure/persistence/entities/wallet.entity";
import { WalletLedgerEntryEntity } from "../../src/wagering/infrastructure/persistence/entities/walletLedgerEntry.entity";
import { WagerTransactionEntity } from "../../src/wagering/infrastructure/persistence/entities/wagerTransaction.entity";
import { InboxMessageEntity } from "../../src/wagering/infrastructure/persistence/entities/inboxMessage.entity";
import { OutboxMessageEntity } from "../../src/wagering/infrastructure/persistence/entities/outboxMessage.entity";

import { WalletRepository } from "../../src/wagering/ports/wallet.repository";
import { WagerTransactionRepository } from "../../src/wagering/ports/wagerTransaction.repository";
import { WalletLedgerEntryRepository } from "../../src/wagering/ports/walletLedgerEntry.repository";
import { OutboxMessageRepository } from "../../src/wagering/ports/outboxMessage.repository";
import { InboxMessageRepository } from "../../src/wagering/ports/inboxMessage.repository";
import { EventPublisher } from "../../src/wagering/ports/eventPublisher";
import { UnitOfWork } from "../../src/wagering/ports/unitOfWork";
import { IdGenerator } from "../../src/wagering/ports/idGenerator";

import { MikroWalletRepository } from "../../src/wagering/infrastructure/persistence/mikroWallet.repository";
import { MikroWagerTransactionRepository } from "../../src/wagering/infrastructure/persistence/mikroWagerTransaction.repository";
import { MikroWalletLedgerEntryRepository } from "../../src/wagering/infrastructure/persistence/mikroWalletLedgerEntry.repository";
import { MikroOutboxMessageRepository } from "../../src/wagering/infrastructure/persistence/mikroOutboxMessage.repository";
import { MikroInboxMessageRepository } from "../../src/wagering/infrastructure/persistence/mikroInboxMessage.repository";
import { MikroUnitOfWork } from "../../src/wagering/infrastructure/persistence/mikroUnitOfWork";
import { UuidV7IdGenerator } from "../../src/wagering/infrastructure/uuidV7IdGenerator";

import { OpenWalletUseCase } from "../../src/wagering/application/openWallet.useCase";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/processWagerTransaction.useCase";
import { OutboxPublisherWorker } from "../../src/wagering/infrastructure/messaging/outboxPublisher.worker";
import { PendingReferenceRetryWorker } from "../../src/wagering/infrastructure/messaging/pendingReferenceRetry.worker";
import { WagerTransactionMessageHandler } from "../../src/wagering/infrastructure/messaging/wagerTransactionMessage.handler";

/** Publisher fake — os testes de integração não precisam de SQS real, só confirmam que a outbox foi gravada certa. */
class FakeEventPublisher {
  async publish(): Promise<void> {}
}

export interface IntegrationTestContext {
  orm: MikroORM;
  openWallet: OpenWalletUseCase;
  processWagerTransaction: ProcessWagerTransactionUseCase;
  outboxPublisherWorker: OutboxPublisherWorker;
  pendingReferenceRetryWorker: PendingReferenceRetryWorker;
  wagerTransactionMessageHandler: WagerTransactionMessageHandler;
  walletRepository: WalletRepository;
  wagerTransactionRepository: WagerTransactionRepository;
  walletLedgerEntryRepository: WalletLedgerEntryRepository;
  outboxMessageRepository: OutboxMessageRepository;
  inboxMessageRepository: InboxMessageRepository;
  /** Executa `fn` dentro de um RequestContext — obrigatório pra qualquer chamada que toque o banco. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

const TEST_DB_CONFIG = {
  dbName: process.env.TEST_POSTGRES_DB ?? "jungle_gaming_test",
  user: process.env.TEST_POSTGRES_USER ?? "postgres",
  password: process.env.TEST_POSTGRES_PASSWORD ?? "postgres_local_dev",
  host: process.env.TEST_POSTGRES_HOST ?? "localhost",
  port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
};

/** Chamar uma vez no beforeAll de cada arquivo de teste. Cria o schema do zero. */
export async function setupIntegrationTest(): Promise<IntegrationTestContext> {
  const orm = await MikroORM.init({
    entities: [WalletEntity, WalletLedgerEntryEntity, WagerTransactionEntity, InboxMessageEntity, OutboxMessageEntity],
    ...TEST_DB_CONFIG,
    debug: false,
  });
  await orm.schema.create();

  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: EntityManager, useValue: orm.em },
      { provide: WalletRepository, useClass: MikroWalletRepository },
      { provide: WagerTransactionRepository, useClass: MikroWagerTransactionRepository },
      { provide: WalletLedgerEntryRepository, useClass: MikroWalletLedgerEntryRepository },
      { provide: OutboxMessageRepository, useClass: MikroOutboxMessageRepository },
      { provide: InboxMessageRepository, useClass: MikroInboxMessageRepository },
      { provide: EventPublisher, useClass: FakeEventPublisher },
      { provide: UnitOfWork, useClass: MikroUnitOfWork },
      { provide: IdGenerator, useClass: UuidV7IdGenerator },
      OpenWalletUseCase,
      ProcessWagerTransactionUseCase,
      OutboxPublisherWorker,
      PendingReferenceRetryWorker,
      WagerTransactionMessageHandler,
    ],
  }).compile();

  return {
    orm,
    openWallet: moduleRef.get(OpenWalletUseCase),
    processWagerTransaction: moduleRef.get(ProcessWagerTransactionUseCase),
    outboxPublisherWorker: moduleRef.get(OutboxPublisherWorker),
    pendingReferenceRetryWorker: moduleRef.get(PendingReferenceRetryWorker),
    wagerTransactionMessageHandler: moduleRef.get(WagerTransactionMessageHandler),
    walletRepository: moduleRef.get(WalletRepository),
    wagerTransactionRepository: moduleRef.get(WagerTransactionRepository),
    walletLedgerEntryRepository: moduleRef.get(WalletLedgerEntryRepository),
    outboxMessageRepository: moduleRef.get(OutboxMessageRepository),
    inboxMessageRepository: moduleRef.get(InboxMessageRepository),
    run: (fn) => RequestContext.create(orm.em, fn),
  };
}

/** Chamar uma vez no afterAll de cada arquivo de teste. */
export async function teardownIntegrationTest(ctx: IntegrationTestContext): Promise<void> {
  await ctx.orm.schema.drop();
  await ctx.orm.close();
}

/** Cria uma wallet direto no banco (bypassa o use case) — útil pra setup de cenários de teste. */
export async function seedWallet(
  ctx: IntegrationTestContext,
  props: { id: string; playerId: string; currency: string; balance: string },
): Promise<void> {
  await ctx.run(async () => {
    const em = RequestContext.getEntityManager()! as EntityManager;
    em.create(WalletEntity, {
      id: props.id,
      playerId: props.playerId,
      currency: props.currency,
      balanceAmount: props.balance,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await em.flush();
  });
}