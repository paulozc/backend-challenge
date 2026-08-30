# ARCHITECTURE.md

> Documento vivo — vai crescendo junto com o projeto. Cada decisão abaixo foi validada com testes antes de virar código definitivo.

## Estrutura de pastas

O projeto segue Arquitetura Hexagonal (Ports & Adapters): o domínio (`src/wagering/domain/`) não importa nada de NestJS, MikroORM ou AWS SDK. Casos de uso (`application/`) orquestram o domínio através de interfaces (`ports/`). Só a camada `infrastructure/` conhece frameworks e bibliotecas externas.

Motivação: as regras de negócio (saldo nunca negativo, idempotência, ledger balanceado) são a parte mais valiosa e estável do sistema — não devem depender de escolhas de framework que podem mudar. Isso também torna o domínio inteiro testável em milissegundos, sem banco, sem Docker, sem servidor HTTP (ver `test/unit/`).

## Money — biblioteca de precisão decimal

**Decisão**: `decimal.js` para representar e operar sobre valores monetários. Nunca `number`/`float`.

**Motivação**: ponto flutuante binário (IEEE-754) não representa exatamente valores decimais (`0.1 + 0.2 !== 0.3`), o que é inaceitável para dinheiro. `decimal.js` opera sobre strings decimais com precisão arbitrária.

**Validação de entrada**: `amount` é aceito apenas no formato `\d+\.\d{2}` — exatamente 2 casas decimais, sem sinal, sem notação científica. Isso rejeita automaticamente `NaN`, `Infinity`, notação científica e valores com escala diferente de 2, sem precisar de checagens separadas.

**Negativos**: `Money.from()` (porta de entrada de contratos externos — API, mensagens) rejeita valores negativos. Porém, operações aritméticas internas (`subtract`, `negate`) *podem* produzir um `Money` negativo — isso é necessário para o `Wallet` calcular "saldo − valor" antes de decidir se rejeita por saldo insuficiente. A regra de não-negatividade do saldo público da wallet é garantida em `Wallet`, não em `Money`.

**`equals` vs `isLessThan` entre moedas diferentes**: decisão deliberada de comportamento diferente.
- `equals()` retorna `false` para moedas diferentes (é uma pergunta com resposta válida: "não, não são iguais").
- `isLessThan()` lança `CurrencyMismatchError` (é uma pergunta sem resposta válida: comparar ordem entre moedas diferentes não faz sentido de negócio).

## WalletLedgerEntry — imutabilidade estrutural

**Decisão**: todos os campos são `readonly`, sem métodos de transição. A validação de que `balanceBefore ± money === balanceAfter` acontece em `create()`, não apenas como uma query (`isBalanced()`) que o chamador precisa lembrar de checar.

**Duas validações independentes na criação**, além do balanceamento:
1. `money` deve ser positivo (magnitude — a `direction` já carrega o sinal).
2. `balanceAfter` não pode ser negativo — mesmo que a aritmética "feche", é uma segunda camada de defesa contra um bug hipotético em `Wallet` (que computa `balanceAfter` via aritmética interna, não via `Money.from()`, então esse cenário é alcançável).

## Wallet — estratégia de concorrência: lock pessimista

**Decisão**: `SELECT ... FOR UPDATE` (via `LockMode.PESSIMISTIC_WRITE` do MikroORM) na linha da wallet, dentro da transação do use case. O lock nunca é global — trava só a linha da wallet específica sendo movimentada.

**Motivação**:
- Operações como REFUND/ROLLBACK envolvem várias etapas de decisão (resolver referência, validar pertencimento, checar reversão dupla) antes de tocar o saldo. Com lock otimista, qualquer conflito de `version` obrigaria a refazer esse processo de decisão inteiro num retry loop, aumentando a complexidade do código de orquestração.
- Nenhuma transação toca mais de uma wallet (referências de REFUND/ROLLBACK devem pertencer à mesma wallet) — elimina o principal risco do lock pessimista, que é deadlock por ordem de lock entre linhas diferentes.
- O trabalho feito com o lock seguro é só leitura/escrita no Postgres (sem chamada externa no meio), então o lock fica aberto por pouco tempo.

**Trade-off assumido**: sob contenção alta numa única wallet ("hot wallet"), transações concorrentes esperam na fila em vez de competir e re-tentar. Isso é aceitável porque movimentações na mesma wallet precisam ser sequenciais de qualquer forma — pessimista serializa esperando, otimista serializaria re-tentando.

**Campo `version`**: mantido mesmo com lock pessimista, mas como contador de auditoria (quantas vezes a wallet mudou de saldo), não como mecanismo de trava. A garantia de concorrência vem do `FOR UPDATE`, não de uma comparação de `version`.

**Nota de implementação**: o lock não vive na classe `Wallet` (que é domínio puro) — é aplicado na camada de repositório/persistência quando a wallet é carregada dentro de uma transação. Ver `infrastructure/persistence/` quando essa camada for construída.

## WagerTransaction — política de referência por kind

**Decisão**: `referenceExternalTransactionId` segue uma política de 3 estados por `kind`:
- **Obrigatória**: `REFUND`, `ROLLBACK`.
- **Opcional**: `WIN` (pode referenciar a BET da mesma rodada, mas não precisa).
- **Proibida**: `BET`, `LOSS`, `OPENING`.

Essa política não está 100% explícita no desafio (que só fala em "exige" para REFUND/ROLLBACK) — é uma interpretação adicional documentada aqui, como pede a seção 7.

**`ledgerDirectionFor()` do ROLLBACK**: implementado recursivamente — pergunta a direção da transação referenciada (`reference.ledgerDirectionFor()`, sem passar referência pra ela) e inverte. Como ROLLBACK só pode referenciar BET/WIN/REFUND (nunca outro ROLLBACK), a recursão nunca tem risco de loop infinito.

**Fora do escopo desta classe** (dependem de consultar outros registros — pertencem ao use case/repositório):
- Valor de REFUND/ROLLBACK deve ser igual ao valor da referência.
- Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.
- `failureCode` distinto para "reversão que causaria saldo negativo" vs. "aposta com saldo insuficiente" — o use case decide qual usar dependendo do `kind` que originou o `InsufficientFundsError`.

**OPENING**: a proibição de submissão via API/fila não é validada dentro da classe (o `create()` genérico aceita esse kind normalmente, porque é usado legitimamente pelo use case interno de abertura de wallet). A proibição é aplicada na validação do DTO da camada HTTP/SQS, que simplesmente não inclui `OPENING` como valor aceito no contrato externo.

## OutboxMessage — backoff e retry

**Decisão**: backoff exponencial (`2^tentativas` segundos), com teto de 5 minutos. `enqueue()` reaproveita `event.eventId` como `id` da linha da outbox — um evento de integração gera exatamente uma linha, mesmo UUID.

**Fora do escopo desta classe**: o limite de tentativas antes de desistir (mover pra um estado terminal ou parar de tentar) é decisão do worker que lê `attempts`, não da classe — `OutboxMessage` só sabe calcular o próximo horário de tentativa.

## Pendente de decisão / a formalizar

- Taxonomia completa de `FailureCode` (seção 7.2) — hoje é só `type FailureCode = string`, será um enum fechado quando os use cases estiverem definidos.
- TTL/limite de tentativas para transações `PENDING_REFERENCE` (seção 7.1).
- Autenticação (seção 2) — decisão ainda não tomada.