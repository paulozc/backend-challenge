# Relatório de teste de carga — Jungle Gaming Wagering Processor

## Ambiente

- Executado em: 2026-08-31T02:44:30.199Z — 2026-08-31T02:45:10.099Z (duração total: 39.9s)
- Runtime: Bun 1.4.0 / Node v26.3.0
- Sistema operacional: win32 x64
- Alvo: `http://localhost:3000`
- **Importante — leia antes de interpretar os números**: este teste roda o gerador de carga e o sistema sob teste na **mesma máquina**, competindo pelos mesmos recursos de CPU/rede/disco (inclusive o Postgres, se estiver rodando localmente também). Isso significa que a latência medida aqui é **pior** do que a latência real do sistema isolado, e o throughput é **mais baixo** do que o sistema conseguiria com um gerador de carga dedicado em outra máquina. Os números são úteis para comparação relativa entre mudanças no código (ex: "essa mudança piorou o p99 em X"), não como benchmark absoluto de capacidade em produção.

## Metodologia

Três fases, nessa ordem:

1. **Baseline** (mede throughput/latência com contenção mínima): 100 wallets criadas com saldo alto (R$100.000,00), depois 2000 apostas de R$1,00 disparadas com concorrência 50, espalhadas uniformemente por todas as wallets — a chance de duas requisições concorrentes baterem na mesma wallet é baixa por construção.
2. **Contenção deliberada** (mede o comportamento sob concorrência real, não hipotética): 5 wallets criadas com saldo exato de R$100,00 cada, depois 50 apostas de R$10,00 disparadas **simultaneamente** (via `Promise.all`, não sequencial) contra cada uma — matematicamente, só 10 por wallet podem ser aceitas antes do saldo se esgotar; o resto **precisa** ser rejeitado com `INSUFFICIENT_FUNDS` para o sistema estar correto.
3. **Lag da outbox**: depois das duas fases, consulta direta no banco (`occurred_at` vs `published_at` em `outbox_messages`) para os eventos gerados durante o teste, com espera de até 20s pro worker de publicação drenar a fila. **Requer que `scripts/outboxWorker.ts` esteja rodando durante o teste** — se não estiver, o lag será artificialmente infinito (mensagens nunca publicadas).

Cada requisição individual usa uma `Idempotency-Key` única (`load-test:<uuid>`), então nenhum resultado é afetado por replay idempotente — cada uma é uma avaliação de negócio nova.

## Fase 1 — Baseline: throughput e latência

- Requisições: 2000
- Duração: 28.08s
- **Throughput: 71.2 req/s**
- Latência: p50 692.8ms · p95 867.2ms · p99 968.1ms · min 257.9ms · max 1043.8ms
- Processadas com sucesso: 2000 (100.0%)
- Rejeitadas por saldo insuficiente (inesperado nessa fase, saldo era alto): 0
- **Taxa de erro (HTTP inesperado ou falha de rede — NÃO inclui rejeições de negócio corretas): 0.00%** (0/2000)

## Fase 2 — Contenção deliberada (conflitos de concorrência)

- Wallets de contenção: 5, saldo R$100,00 cada
- Requisições simultâneas por wallet: 50
- Total de requisições: 250
- **Processadas com sucesso: 50** (esperado exatamente: 50)
- **Rejeitadas por saldo insuficiente (conflito de concorrência resolvido corretamente): 200** (esperado exatamente: 200)
- Erros inesperados: 0
- **Veredito de correção**: ✅ EXATO — nenhum saldo negativo, nenhuma aposta a mais aceita, nenhum erro inesperado sob concorrência real de carga.

## Fase 3 — Lag da outbox (criação → publicação no SQS)

- Amostra: 4510 eventos publicados durante a janela do teste
- p50 5762.0ms · p95 7880.0ms · p99 7899.0ms · max 7939.0ms
- Mensagens ainda não publicadas ao final da espera: 0 ✅ (fila drenada completamente)

## Honestidade sobre limitações deste experimento

- Roda numa única máquina de desenvolvimento, sem isolamento entre gerador de carga, aplicação e banco — não é um ambiente de produção nem um benchmark de capacidade.
- Não há meta de RPS: o objetivo é a metodologia e a leitura correta dos números, não bater um número específico.
- A fase de contenção usa poucas wallets (5) de propósito — é sobre *correção sob concorrência*, não sobre volume.
- Uma única execução não é estatisticamente robusta; para comparar mudanças de código com confiança, rode múltiplas vezes e compare distribuições, não só a média de uma execução.
