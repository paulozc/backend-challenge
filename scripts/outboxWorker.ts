import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { MikroORM, RequestContext } from "@mikro-orm/postgresql";
import { AppModule } from "../src/app.module";
import { OutboxPublisherWorker } from "../src/wagering/infrastructure/messaging/outboxPublisher.worker";

const POLL_INTERVAL_MS = 2000;

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(OutboxPublisherWorker);
  const orm = app.get(MikroORM);

  console.log("outbox publisher worker iniciado.");

  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  while (running) {
    // funciona mesmo sem isso hoje (pollOnce já abre sua própria transactional() como
    // primeira operação) — mas embrulhar aqui também deixa isso robusto contra qualquer
    // mudança futura que adicione uma leitura antes da transação, como aconteceu no consumidor SQS.
    const processed = await RequestContext.create(orm.em, () => worker.pollOnce());
    if (processed === 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  await app.close();
  console.log("outbox publisher worker encerrado.");
}

bootstrap();