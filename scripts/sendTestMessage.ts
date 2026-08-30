import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";

const walletId = process.argv[2];
if (!walletId) {
  console.error("uso: bun run scripts/sendTestMessage.ts <walletId>");
  process.exit(1);
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

  const externalTransactionId = `bet-${Date.now()}`;
  const message = {
    messageId: randomUUID(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: randomUUID(), // não precisa bater com o player da wallet pro teste
      walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    },
  };

  const queueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL ?? "http://localhost:4566/000000000000/wager-transactions.fifo";

  const result = await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageDeduplicationId: message.data.externalTransactionId,
      MessageGroupId: `wallet-${walletId}`,
    }),
  );

  console.log("mensagem enviada:", result.MessageId);
  console.log("corpo:", JSON.stringify(message, null, 2));
}

main().catch((err) => {
  console.error("ERRO:", err);
  process.exit(1);
});