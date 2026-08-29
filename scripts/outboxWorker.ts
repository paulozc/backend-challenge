import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { OutboxPublisherWorker } from "../src/wagering/infrastructure/messaging/outboxPublisher.worker";

const POLL_INTERVAL_MS = 2000;

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(OutboxPublisherWorker);

  console.log("outbox publisher worker iniciado.");

  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  while (running) {
    const processed = await worker.pollOnce();
    if (processed === 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  await app.close();
  console.log("outbox publisher worker encerrado.");
}

bootstrap();