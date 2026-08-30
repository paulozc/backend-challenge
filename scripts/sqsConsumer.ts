import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { MikroORM, RequestContext } from "@mikro-orm/postgresql";
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { AppModule } from "../src/app.module";
import { WagerTransactionMessageHandler } from "../src/wagering/infrastructure/messaging/wagerTransactionMessage.handler";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const handler = app.get(WagerTransactionMessageHandler);
  const orm = app.get(MikroORM);

  const client = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT,
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
  const queueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("WAGER_TRANSACTIONS_QUEUE_URL não configurada");
  }

  console.log("consumidor SQS iniciado.");

  let running = true;
  let inFlight = 0;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  while (running) {
    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 10, // long polling
      }),
    );

    const messages = result.Messages ?? [];
    await Promise.all(
      messages.map(async (message) => {
        inFlight++;
        try {
          // RequestContext.create() garante que TODA operação de banco do handler tenha
          // contexto ambiente — inclusive a checagem de inbox, que acontece ANTES de
          // qualquer transactional() (de propósito, pra não pagar o custo de uma
          // transação inteira só pra confirmar "já processei essa mensagem?").
          const outcome = await RequestContext.create(orm.em, () =>
            handler.handle(message.MessageId!, message.Body!),
          );
          if (outcome === "ack") {
            await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
          }
          // "retry": não deleta — a visibilidade expira naturalmente e o SQS redelivera
        } finally {
          inFlight--;
        }
      }),
    );
  }

  // SIGTERM: espera as mensagens em andamento terminarem antes de fechar
  while (inFlight > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await app.close();
  console.log("consumidor SQS encerrado.");
}

bootstrap();