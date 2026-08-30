#!/bin/bash
# Roda uma vez quando o LocalStack sinaliza "ready" (mecanismo de
# /etc/localstack/init/ready.d/*.sh). awslocal = aws cli pré-configurado pro
# endpoint local, já vem na imagem do LocalStack.
set -euo pipefail

echo "[localstack-init] criando fila DLQ..."
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

echo "[localstack-init] DLQ ARN: $DLQ_ARN"

# JSON puro (não sintaxe abreviada) pro --attributes -- a sintaxe abreviada do AWS CLI
# mistura mal com um valor que já é ele mesmo um JSON aninhado (RedrivePolicy),
# então escapamos e montamos o JSON completo explicitamente pra evitar ambiguidade
# de parsing. maxReceiveCount=5: mesma ordem de grandeza usada como referência em
# outras partes do projeto (ex: limite de tentativas do worker de PENDING_REFERENCE).
REDRIVE_POLICY="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":5}"
ESCAPED_REDRIVE_POLICY=$(echo "$REDRIVE_POLICY" | sed 's/"/\\"/g')
MAIN_QUEUE_ATTRIBUTES="{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"RedrivePolicy\":\"$ESCAPED_REDRIVE_POLICY\"}"

echo "[localstack-init] criando fila principal (entrada de requisições dos provedores, seção 10)..."
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$MAIN_QUEUE_ATTRIBUTES"

echo "[localstack-init] criando fila de eventos de integração (saída, seção 11 — nome nosso, não do desafio)..."
awslocal sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

echo "[localstack-init] filas criadas:"
awslocal sqs list-queues