import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";

// ---------- configuração (via env, com defaults sensatos pra rodar numa máquina de dev) ----------
const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? "http://localhost:3000";
const WALLET_COUNT = Number(process.env.LOAD_TEST_WALLET_COUNT ?? 100);
const BASELINE_REQUESTS = Number(process.env.LOAD_TEST_BASELINE_REQUESTS ?? 2000);
const BASELINE_CONCURRENCY = Number(process.env.LOAD_TEST_BASELINE_CONCURRENCY ?? 50);
const CONTENTION_WALLETS = Number(process.env.LOAD_TEST_CONTENTION_WALLETS ?? 5);
const CONTENTION_CONCURRENCY_PER_WALLET = Number(process.env.LOAD_TEST_CONTENTION_CONCURRENCY ?? 50);
const CONTENTION_WALLET_BALANCE = 100; // saldo inicial de cada wallet de contenção
const CONTENTION_BET_AMOUNT = 10; // -> exatamente 10 sucessos esperados por wallet de contenção
const OUTBOX_LAG_MAX_WAIT_MS = Number(process.env.LOAD_TEST_OUTBOX_WAIT_MS ?? 20_000);
const OUTBOX_LAG_POLL_INTERVAL_MS = 1000;

// ---------- utilidades ----------

/** Executor com concorrência limitada — evita disparar milhares de requisições de uma vez só. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const i = nextIndex++;
    if (i >= items.length) return;
    await worker(items[i]!, i);
    return runNext();
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(runners);
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(index, sortedAsc.length - 1))]!;
}

interface RequestResult {
  latencyMs: number;
  httpStatus: number;
  outcome: "PROCESSED" | "REJECTED_INSUFFICIENT_FUNDS" | "REJECTED_OTHER" | "UNEXPECTED_ERROR" | "NETWORK_ERROR";
  failureCode?: string;
}

async function fireBet(walletId: string, playerId: string, amount: string): Promise<RequestResult> {
  const externalTransactionId = randomUUID();
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/wagering/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `load-test:${externalTransactionId}` },
      body: JSON.stringify({
        providerId: "load-test",
        externalTransactionId,
        playerId,
        walletId,
        roundId: `load-test-round-${externalTransactionId}`,
        gameId: "load-test-game",
        kind: "BET",
        money: { amount, currency: "BRL" },
      }),
    });
    const latencyMs = performance.now() - start;
    const body = (await res.json().catch(() => null)) as { failureCode?: string } | null;

    if (res.status === 200) return { latencyMs, httpStatus: res.status, outcome: "PROCESSED" };
    if (res.status === 422) {
      if (body?.failureCode === "INSUFFICIENT_FUNDS") {
        return { latencyMs, httpStatus: res.status, outcome: "REJECTED_INSUFFICIENT_FUNDS", failureCode: body.failureCode };
      }
      return { latencyMs, httpStatus: res.status, outcome: "REJECTED_OTHER", failureCode: body?.failureCode };
    }
    return { latencyMs, httpStatus: res.status, outcome: "UNEXPECTED_ERROR", failureCode: body?.failureCode };
  } catch {
    return { latencyMs: performance.now() - start, httpStatus: 0, outcome: "NETWORK_ERROR" };
  }
}

async function createWallet(initialBalance: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const res = await fetch(`${BASE_URL}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount: initialBalance, currency: "BRL" } }),
  });
  if (res.status !== 201) {
    throw new Error(`falha ao criar wallet de setup: HTTP ${res.status} — ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { walletId: body.id, playerId };
}

function summarizeLatencies(results: RequestResult[]) {
  const sorted = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    count: results.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function countBy<T extends string>(results: RequestResult[], key: T): number {
  return results.filter((r) => r.outcome === key).length;
}

// ---------- fases do teste ----------

async function checkServerIsUp(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health/live`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    throw new Error(
      `Não consegui alcançar ${BASE_URL}/health/live (${(err as Error).message}). ` +
        `A aplicação precisa estar rodando (bun run start) antes do teste de carga. ` +
        `Pro lag da outbox fazer sentido, o outbox worker (bun run scripts/outboxWorker.ts) também precisa estar rodando.`,
    );
  }
}

async function setupBaselineWallets(): Promise<{ walletId: string; playerId: string }[]> {
  console.log(`\n[setup] criando ${WALLET_COUNT} wallets pro baseline (saldo alto, não deve haver rejeição por saldo)...`);
  const wallets: { walletId: string; playerId: string }[] = [];
  const indices = Array.from({ length: WALLET_COUNT }, (_, i) => i);
  await runWithConcurrency(indices, 20, async () => {
    wallets.push(await createWallet("100000.00"));
  });
  console.log(`[setup] ${wallets.length} wallets criadas.`);
  return wallets;
}

async function runBaselinePhase(wallets: { walletId: string; playerId: string }[]): Promise<RequestResult[]> {
  console.log(`\n[baseline] disparando ${BASELINE_REQUESTS} apostas de R$1,00, concorrência ${BASELINE_CONCURRENCY}, espalhadas por ${wallets.length} wallets (baixíssima contenção esperada)...`);
  const results: RequestResult[] = [];
  const requestIndices = Array.from({ length: BASELINE_REQUESTS }, (_, i) => i);
  const started = performance.now();
  await runWithConcurrency(requestIndices, BASELINE_CONCURRENCY, async (i) => {
    const wallet = wallets[i % wallets.length]!;
    const result = await fireBet(wallet.walletId, wallet.playerId, "1.00");
    results.push(result);
  });
  const elapsedSeconds = (performance.now() - started) / 1000;
  console.log(`[baseline] concluído em ${elapsedSeconds.toFixed(2)}s.`);
  return results;
}

async function runContentionPhase(): Promise<{ results: RequestResult[]; walletIds: string[] }> {
  console.log(
    `\n[contenção] criando ${CONTENTION_WALLETS} wallets com saldo R$${CONTENTION_WALLET_BALANCE},00 e disparando ` +
      `${CONTENTION_CONCURRENCY_PER_WALLET} apostas de R$${CONTENTION_BET_AMOUNT},00 SIMULTÂNEAS em cada uma — ` +
      `só ${CONTENTION_WALLET_BALANCE / CONTENTION_BET_AMOUNT} por wallet devem ser aceitas, o resto tem que ser rejeitado por saldo insuficiente...`,
  );
  const contentionWallets: { walletId: string; playerId: string }[] = [];
  for (let i = 0; i < CONTENTION_WALLETS; i++) {
    contentionWallets.push(await createWallet(CONTENTION_WALLET_BALANCE.toFixed(2)));
  }

  const results: RequestResult[] = [];
  // todas as wallets de contenção disparam ao mesmo tempo (Promise.all), e dentro de cada
  // wallet, todas as N requisições concorrentes também — contenção real, não sequencial
  await Promise.all(
    contentionWallets.map(async (wallet) => {
      const requestIndices = Array.from({ length: CONTENTION_CONCURRENCY_PER_WALLET }, (_, i) => i);
      await runWithConcurrency(requestIndices, CONTENTION_CONCURRENCY_PER_WALLET, async () => {
        const result = await fireBet(wallet.walletId, wallet.playerId, CONTENTION_BET_AMOUNT.toFixed(2));
        results.push(result);
      });
    }),
  );

  console.log(`[contenção] concluído.`);
  return { results, walletIds: contentionWallets.map((w) => w.walletId) };
}

async function measureOutboxLag(testStartedAt: Date): Promise<{
  sampleSize: number;
  stillPendingAfterWait: number;
  lagMs: { p50: number; p95: number; p99: number; max: number } | null;
}> {
  console.log(`\n[outbox lag] conectando no banco pra medir o atraso entre criação e publicação dos eventos...`);
  const orm = await MikroORM.init(config);
  try {
    let waitedMs = 0;
    let pendingCount = -1;
    while (waitedMs < OUTBOX_LAG_MAX_WAIT_MS) {
      const rows: { count: string }[] = await orm.em.execute(
        `SELECT count(*)::text as count FROM outbox_messages WHERE occurred_at >= ? AND published_at IS NULL`,
        [testStartedAt],
      );
      pendingCount = Number(rows[0]?.count ?? 0);
      if (pendingCount === 0) break;
      console.log(`[outbox lag] ainda ${pendingCount} mensagens não publicadas, esperando o worker drenar... (${waitedMs / 1000}s)`);
      await new Promise((resolve) => setTimeout(resolve, OUTBOX_LAG_POLL_INTERVAL_MS));
      waitedMs += OUTBOX_LAG_POLL_INTERVAL_MS;
    }

    const publishedRows: { occurred_at: Date; published_at: Date }[] = await orm.em.execute(
      `SELECT occurred_at, published_at FROM outbox_messages WHERE occurred_at >= ? AND published_at IS NOT NULL`,
      [testStartedAt],
    );
    const lags = publishedRows
      .map((r) => new Date(r.published_at).getTime() - new Date(r.occurred_at).getTime())
      .sort((a, b) => a - b);

    return {
      sampleSize: lags.length,
      stillPendingAfterWait: pendingCount,
      lagMs: lags.length > 0 ? { p50: percentile(lags, 50), p95: percentile(lags, 95), p99: percentile(lags, 99), max: lags[lags.length - 1]! } : null,
    };
  } finally {
    await orm.close();
  }
}

// ---------- relatório ----------

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function buildReport(params: {
  startedAt: Date;
  finishedAt: Date;
  baseline: { results: RequestResult[]; elapsedSeconds: number };
  contention: { results: RequestResult[]; walletIds: string[] };
  outboxLag: Awaited<ReturnType<typeof measureOutboxLag>>;
}): string {
  const { startedAt, finishedAt, baseline, contention, outboxLag } = params;
  const baselineLatency = summarizeLatencies(baseline.results);
  const baselineErrors = countBy(baseline.results, "UNEXPECTED_ERROR") + countBy(baseline.results, "NETWORK_ERROR");
  const baselineThroughput = baseline.results.length / baseline.elapsedSeconds;

  const contentionSuccesses = countBy(contention.results, "PROCESSED");
  const contentionRejectedByFunds = countBy(contention.results, "REJECTED_INSUFFICIENT_FUNDS");
  const contentionUnexpected = countBy(contention.results, "UNEXPECTED_ERROR") + countBy(contention.results, "NETWORK_ERROR");
  const expectedSuccessesPerWallet = CONTENTION_WALLET_BALANCE / CONTENTION_BET_AMOUNT;
  const expectedTotalSuccesses = expectedSuccessesPerWallet * contention.walletIds.length;

  return `# Relatório de teste de carga — Jungle Gaming Wagering Processor

## Ambiente

- Executado em: ${startedAt.toISOString()} — ${finishedAt.toISOString()} (duração total: ${((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1)}s)
- Runtime: Bun ${typeof Bun !== "undefined" ? Bun.version : "?"} / Node ${process.version}
- Sistema operacional: ${process.platform} ${process.arch}
- Alvo: \`${BASE_URL}\`
- **Importante — leia antes de interpretar os números**: este teste roda o gerador de carga e o sistema sob teste na **mesma máquina**, competindo pelos mesmos recursos de CPU/rede/disco (inclusive o Postgres, se estiver rodando localmente também). Isso significa que a latência medida aqui é **pior** do que a latência real do sistema isolado, e o throughput é **mais baixo** do que o sistema conseguiria com um gerador de carga dedicado em outra máquina. Os números são úteis para comparação relativa entre mudanças no código (ex: "essa mudança piorou o p99 em X"), não como benchmark absoluto de capacidade em produção.

## Metodologia

Três fases, nessa ordem:

1. **Baseline** (mede throughput/latência com contenção mínima): ${WALLET_COUNT} wallets criadas com saldo alto (R$100.000,00), depois ${BASELINE_REQUESTS} apostas de R$1,00 disparadas com concorrência ${BASELINE_CONCURRENCY}, espalhadas uniformemente por todas as wallets — a chance de duas requisições concorrentes baterem na mesma wallet é baixa por construção.
2. **Contenção deliberada** (mede o comportamento sob concorrência real, não hipotética): ${CONTENTION_WALLETS} wallets criadas com saldo exato de R$${CONTENTION_WALLET_BALANCE},00 cada, depois ${CONTENTION_CONCURRENCY_PER_WALLET} apostas de R$${CONTENTION_BET_AMOUNT},00 disparadas **simultaneamente** (via \`Promise.all\`, não sequencial) contra cada uma — matematicamente, só ${expectedSuccessesPerWallet} por wallet podem ser aceitas antes do saldo se esgotar; o resto **precisa** ser rejeitado com \`INSUFFICIENT_FUNDS\` para o sistema estar correto.
3. **Lag da outbox**: depois das duas fases, consulta direta no banco (\`occurred_at\` vs \`published_at\` em \`outbox_messages\`) para os eventos gerados durante o teste, com espera de até ${OUTBOX_LAG_MAX_WAIT_MS / 1000}s pro worker de publicação drenar a fila. **Requer que \`scripts/outboxWorker.ts\` esteja rodando durante o teste** — se não estiver, o lag será artificialmente infinito (mensagens nunca publicadas).

Cada requisição individual usa uma \`Idempotency-Key\` única (\`load-test:<uuid>\`), então nenhum resultado é afetado por replay idempotente — cada uma é uma avaliação de negócio nova.

## Fase 1 — Baseline: throughput e latência

- Requisições: ${baseline.results.length}
- Duração: ${baseline.elapsedSeconds.toFixed(2)}s
- **Throughput: ${baselineThroughput.toFixed(1)} req/s**
- Latência: p50 ${formatMs(baselineLatency.p50)} · p95 ${formatMs(baselineLatency.p95)} · p99 ${formatMs(baselineLatency.p99)} · min ${formatMs(baselineLatency.min)} · max ${formatMs(baselineLatency.max)}
- Processadas com sucesso: ${countBy(baseline.results, "PROCESSED")} (${((countBy(baseline.results, "PROCESSED") / baseline.results.length) * 100).toFixed(1)}%)
- Rejeitadas por saldo insuficiente (inesperado nessa fase, saldo era alto): ${countBy(baseline.results, "REJECTED_INSUFFICIENT_FUNDS")}
- **Taxa de erro (HTTP inesperado ou falha de rede — NÃO inclui rejeições de negócio corretas): ${((baselineErrors / baseline.results.length) * 100).toFixed(2)}%** (${baselineErrors}/${baseline.results.length})

## Fase 2 — Contenção deliberada (conflitos de concorrência)

- Wallets de contenção: ${contention.walletIds.length}, saldo R$${CONTENTION_WALLET_BALANCE},00 cada
- Requisições simultâneas por wallet: ${CONTENTION_CONCURRENCY_PER_WALLET}
- Total de requisições: ${contention.results.length}
- **Processadas com sucesso: ${contentionSuccesses}** (esperado exatamente: ${expectedTotalSuccesses})
- **Rejeitadas por saldo insuficiente (conflito de concorrência resolvido corretamente): ${contentionRejectedByFunds}** (esperado exatamente: ${contention.results.length - expectedTotalSuccesses})
- Erros inesperados: ${contentionUnexpected}
- **Veredito de correção**: ${
    contentionSuccesses === expectedTotalSuccesses && contentionUnexpected === 0
      ? "✅ EXATO — nenhum saldo negativo, nenhuma aposta a mais aceita, nenhum erro inesperado sob concorrência real de carga."
      : "⚠️ DIVERGÊNCIA — o número de sucessos ou erros não bateu com o esperado. Isso indicaria um problema real de controle de concorrência sob carga e precisaria de investigação imediata, não só sob os testes de integração em pequena escala."
  }

## Fase 3 — Lag da outbox (criação → publicação no SQS)

${
  outboxLag.lagMs
    ? `- Amostra: ${outboxLag.sampleSize} eventos publicados durante a janela do teste
- p50 ${formatMs(outboxLag.lagMs.p50)} · p95 ${formatMs(outboxLag.lagMs.p95)} · p99 ${formatMs(outboxLag.lagMs.p99)} · max ${formatMs(outboxLag.lagMs.max)}
- Mensagens ainda não publicadas ao final da espera: ${outboxLag.stillPendingAfterWait}${outboxLag.stillPendingAfterWait > 0 ? " ⚠️ (o outbox worker pode não estar rodando, ou o backlog é maior do que o tempo de espera configurado)" : " ✅ (fila drenada completamente)"}`
    : `- ⚠️ Nenhum evento publicado foi encontrado na janela do teste — o outbox worker (\`bun run scripts/outboxWorker.ts\`) provavelmente não estava rodando durante a execução. Suba-o e rode o teste de novo para medir o lag real.`
}

## Honestidade sobre limitações deste experimento

- Roda numa única máquina de desenvolvimento, sem isolamento entre gerador de carga, aplicação e banco — não é um ambiente de produção nem um benchmark de capacidade.
- Não há meta de RPS: o objetivo é a metodologia e a leitura correta dos números, não bater um número específico.
- A fase de contenção usa poucas wallets (${CONTENTION_WALLETS}) de propósito — é sobre *correção sob concorrência*, não sobre volume.
- Uma única execução não é estatisticamente robusta; para comparar mudanças de código com confiança, rode múltiplas vezes e compare distribuições, não só a média de uma execução.
`;
}

// ---------- orquestração ----------

async function main() {
  console.log(`Teste de carga — Jungle Gaming Wagering Processor`);
  console.log(`Alvo: ${BASE_URL}`);
  await checkServerIsUp();

  const startedAt = new Date();

  const baselineWallets = await setupBaselineWallets();
  const baselineStart = performance.now();
  const baselineResults = await runBaselinePhase(baselineWallets);
  const baselineElapsedSeconds = (performance.now() - baselineStart) / 1000;

  const contention = await runContentionPhase();

  const outboxLag = await measureOutboxLag(startedAt);

  const finishedAt = new Date();

  const report = buildReport({
    startedAt,
    finishedAt,
    baseline: { results: baselineResults, elapsedSeconds: baselineElapsedSeconds },
    contention,
    outboxLag,
  });

  console.log("\n" + report);

  const outputPath = "./load-test-results.md";
  await Bun.write(outputPath, report);
  console.log(`\nRelatório salvo em ${outputPath}`);
}

main().catch((err) => {
  console.error("ERRO no teste de carga:", err);
  process.exit(1);
});