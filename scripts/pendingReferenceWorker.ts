import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { PendingReferenceRetryWorker } from "../src/wagering/infrastructure/messaging/pendingReferenceRetry.worker";

const POLL_INTERVAL_MS = 10_000; // menos frequente que o outbox — backoff mínimo já é 5s+

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(PendingReferenceRetryWorker);

  console.log("pending reference retry worker iniciado.");

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
  console.log("pending reference retry worker encerrado.");
}

bootstrap();