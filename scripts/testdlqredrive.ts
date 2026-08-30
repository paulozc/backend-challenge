import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";

const MAIN_QUEUE_URL = process.env.WAGER_TRANSACTIONS_QUEUE_URL ?? "http://localhost:4566/000000000000/wager-transactions.fifo";
const DLQ_URL = process.env.WAGER_TRANSACTIONS_DLQ_URL ?? "http://localhost:4566/000000000000/wager-transactions-dlq.fifo";
const MAX_RECEIVE_COUNT = 5; // precisa bater com o que está no script de init do LocalStack

function assert(cond: boolean, label: string) {
  console.log(`${cond ? "OK  " : "FALHOU"} ${label}`);
}

async function main() {
  const client = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });

  const dedupId = `dlq-test-${randomUUID()}`;
  console.log(`--- enviando mensagem "envenenada" (dedupId=${dedupId}) ---`);
  await client.send(
    new SendMessageCommand({
      QueueUrl: MAIN_QUEUE_URL,
      MessageBody: JSON.stringify({ note: "mensagem de teste do redrive — nunca deve ser processada de verdade" }),
      MessageGroupId: "dlq-redrive-test",
      MessageDeduplicationId: dedupId,
    }),
  );

  console.log(`\n--- recebendo repetidamente sem confirmar (simula falha permanente), até passar de ${MAX_RECEIVE_COUNT} tentativas ---`);
  for (let attempt = 1; attempt <= MAX_RECEIVE_COUNT + 1; attempt++) {
    const result = await client.send(
      new ReceiveMessageCommand({ QueueUrl: MAIN_QUEUE_URL, MaxNumberOfMessages: 1, WaitTimeSeconds: 2 }),
    );
    const message = result.Messages?.[0];
    if (!message) {
      console.log(`tentativa ${attempt}: fila principal vazia — já foi pro DLQ`);
      break;
    }
    console.log(`tentativa ${attempt}: recebida, forçando redelivery imediata (sem esperar o VisibilityTimeout natural)`);
    await client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: MAIN_QUEUE_URL, ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: 0 }),
    );
  }

  console.log("\n--- checando a DLQ ---");
  const dlqResult = await client.send(
    new ReceiveMessageCommand({ QueueUrl: DLQ_URL, MaxNumberOfMessages: 1, WaitTimeSeconds: 2 }),
  );
  const foundInDlq = (dlqResult.Messages?.length ?? 0) === 1;
  assert(foundInDlq, "a mensagem migrou pra DLQ depois de esgotar as tentativas");
  if (foundInDlq && dlqResult.Messages?.[0]) {
    console.log("corpo na DLQ:", dlqResult.Messages[0].Body);
  }

  const mainCheck = await client.send(
    new ReceiveMessageCommand({ QueueUrl: MAIN_QUEUE_URL, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
  );
  assert((mainCheck.Messages?.length ?? 0) === 0, "fila principal está vazia (a mensagem não voltou pra lá)");
}

main().catch((err) => {
  console.error("ERRO:", err);
  process.exit(1);
});