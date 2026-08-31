# Jungle Gaming — Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores de jogo, via HTTP e SQS. Construído com correção financeira, concorrência entre múltiplas instâncias e idempotência persistente como requisitos centrais — não como reboco por cima de um CRUD.

Para o histórico completo de decisões técnicas, alternativas consideradas e validações feitas ao longo da construção, ver [`ARCHITECTURE.md`](./ARCHITECTURE.md). Este README é o ponto de entrada rápido: o que o sistema faz, como rodar, e como as regras do desafio foram atendidas.

## Stack

Bun · TypeScript · NestJS · MikroORM v7 · PostgreSQL 16 · AWS SQS (LocalStack em dev) · Arquitetura Hexagonal (Ports & Adapters)

## Como rodar

### 1. Infraestrutura (Postgres + LocalStack)

```bash
docker-compose up -d
```

Isso sobe o Postgres (cria a role `app_user` automaticamente na primeira inicialização) e o LocalStack (cria as 3 filas SQS — `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo` — com redrive policy configurado).

### 2. Instalar dependências e configurar `.env`

```bash
bun install
cp .env.example .env
```

Ajuste o `.env` se os valores padrão não baterem com o seu `docker-compose.yml` (senha do Postgres, endpoint do SQS etc.).

### 3. Rodar as migrations

```bash
bun run migration:up
```

Migrations rodam com a role `postgres` (dono do banco em dev); a aplicação, em runtime, usa a role `app_user`, com privilégio mínimo (sem DDL, sem `DELETE` em nenhuma tabela).

### 4. Subir a aplicação

```bash
bun run start
```

A API sobe em `http://localhost:3000` (ou a porta definida em `PORT`). Health checks em `/health/live` e `/health/ready`.

### 5. Subir os workers (processos separados)

```bash
bun run scripts/outboxWorker.ts           # publica eventos de integração pendentes
bun run scripts/sqsConsumer.ts            # consome wager-transactions.fifo
bun run scripts/pendingReferenceWorker.ts # reprocessa REFUND/ROLLBACK com referência ainda não recebida
```

Cada um roda como processo independente da API HTTP — em produção, cada um seria um dyno/pod separado.

## Testando

```bash
bun test test/integration
```

33 testes de integração contra Postgres real, incluindo o cenário obrigatório de concorrência (seção 8 do desafio: duas apostas simultâneas sobre o mesmo saldo, apenas uma processa). Ver [`test/integration/`](./test/integration/).

Testes unitários de domínio (puro, sem banco):

```bash
bun test src/wagering/domain/test/unit
```

### Teste de carga (diferencial)

```bash
bun run test:load
```

Requer a aplicação (`bun run start`) e o outbox worker (`bun run scripts/outboxWorker.ts`) rodando em paralelo. Três fases: baseline de throughput/latência, contenção deliberada (concorrência real via `Promise.all` sobre poucas wallets, com veredito explícito de correção), e lag da outbox (criação → publicação). Gera um relatório em `load-test-results.md` com ambiente, metodologia, percentis (p50/p95/p99), taxa de erro e as limitações do experimento — sem meta de RPS, o objetivo é a metodologia e a honestidade da análise.

## Garantias principais, e como cada uma foi atendida

| Regra do desafio | Como foi atendida |
|---|---|
| Não usar `number`/`float`/`double` pra dinheiro | `Money` (domínio) usa `decimal.js` internamente; colunas `numeric(19,2)` no Postgres — nunca `float`/`double` |
| Não usar cache em memória pra idempotência | `idempotency_key` como constraint `UNIQUE` no Postgres; réplica sempre lê do banco, nunca de um cache local |
| Não confiar só no SQS FIFO pra consistência | Inbox persistente (`(message_id, consumer_name)` como chave), `idempotency_key` na própria `WagerTransaction` como segunda camada — a garantia real é o banco, o SQS FIFO é só uma otimização de ordenação |
| Não publicar eventos antes do commit | Eventos são gravados na tabela `outbox_messages` **dentro da mesma transação** da mudança financeira; um worker separado é quem efetivamente publica pro SQS, só depois do commit |
| Não sobrescrever/excluir lançamentos do ledger | `wallet_ledger_entries` é append-only: `REVOKE UPDATE, DELETE` da role `app_user` **e** um trigger que lança exceção em qualquer tentativa — duas camadas, não uma |
| Não usar lock global compartilhado | Lock pessimista (`SELECT ... FOR UPDATE`) por **wallet individual** — apostas em wallets diferentes nunca se bloqueiam entre si |
| Não implementar saldo como read→calculate→update sem controle de concorrência | Toda mutação de saldo passa pelo lock pessimista da wallet antes de ler o saldo atual; testado com concorrência real (`Promise.all`), não sequencial |
| Correta com múltiplas instâncias | Nenhum estado em memória entre requisições; tudo coordenado via Postgres (locks, constraints) e SQS; testado com múltiplos "workers" concorrentes de verdade |
| Unicidade, imutabilidade e não-negatividade no schema, não só na aplicação | `CHECK` constraints (`balance_amount >= 0`, moeda com formato válido), índices únicos parciais (reversão dupla), triggers de imutabilidade — tudo no schema do Postgres |

## Endpoints HTTP

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Abre uma wallet, com saldo inicial opcional |
| `GET` | `/wallets/:walletId` | Consulta uma wallet |
| `GET` | `/wallets/:walletId/ledger` | Lista o ledger da wallet, paginado por cursor opaco |
| `POST` | `/wagering/transactions` | Submete uma transação (`BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`); exige header `Idempotency-Key` |
| `GET` | `/wagering/transactions/:transactionId` | Consulta uma transação pelo id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identidade externa do provedor |
| `GET` | `/health/live` | Liveness — não checa dependências |
| `GET` | `/health/ready` | Readiness — checa conexão com o Postgres |

`POST /wagering/transactions` mapeia o resultado de negócio pro status HTTP: `200` (processada), `422` (rejeitada por regra de negócio), `202` (aceita, aguardando referência). Falha transitória de infraestrutura (ex: Postgres momentaneamente indisponível) responde `503`, distinta de qualquer erro de negócio — ver `TransientInfrastructureFailureFilter`.

## Estrutura do projeto

```
src/
├── main.ts, app.module.ts        # bootstrap
├── health/                       # health checks
└── wagering/
    ├── domain/                   # entidades de domínio puras, sem dependência de framework
    │   └── events/                 # eventos de integração concretos
    ├── ports/                    # interfaces (repositórios, UnitOfWork, IdGenerator, EventPublisher)
    ├── application/               # use cases (OpenWallet, ProcessWagerTransaction)
    └── infrastructure/
        ├── persistence/            # entidades MikroORM, mappers, implementações dos repositórios
        ├── http/                    # controllers, DTOs, presenters
        └── messaging/               # workers (outbox, pending reference), handler do consumidor SQS

scripts/                          # processos que rodam fora da API HTTP (migrations, workers)
migrations/                       # migrations do MikroORM
docker/                           # scripts de inicialização do Postgres e LocalStack
test/integration/                 # testes de integração (bun:test, contra Postgres real)
```

Arquitetura hexagonal: o domínio (`domain/`) não importa nada de `infrastructure/`; use cases (`application/`) dependem só de `ports/` (interfaces), nunca de implementações concretas. Isso é o que permitiu testar lock pessimista, idempotência e concorrência real sem precisar de mocks nas partes que importam.

## Decisões técnicas notáveis

Resumo — a justificativa completa de cada uma está no `ARCHITECTURE.md`:

- **`decimal.js` em vez de `number`** para todo valor monetário no domínio; `numeric(19,2)` no banco.
- **UUID v7** (time-ordenado) para todos os ids gerados pela aplicação — usado diretamente como cursor de paginação do ledger.
- **`@mikro-orm/nestjs` não é usado** — incompatível com o NestJS 12 no momento da construção; a integração (inicialização do ORM + isolamento de `EntityManager` por requisição) foi reimplementada manualmente.
- **Duas transações separadas no consumidor SQS** (não uma só, aninhada) — uma limitação real do MikroORM com transações aninhadas contra Postgres foi descoberta e documentada; a correção depende da proteção por `idempotency_key`, validada explicitamente com um teste que simula o cenário de crash entre as duas transações.
- **`PESSIMISTIC_PARTIAL_WRITE`** (gera `SELECT ... FOR UPDATE SKIP LOCKED`) para os workers de outbox e reprocessamento — múltiplos workers concorrentes pegam lotes disjuntos, sem esperar uns pelos outros.