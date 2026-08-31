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

## Mapeamento de Money no schema — uma coluna `currency` compartilhada

**Decisão**: em qualquer linha que carregue um ou mais valores `Money`, existe **uma única coluna `currency`**, reaproveitada por todos eles — nunca uma coluna de moeda por campo monetário.

- `wallets`: uma `currency` (identidade da wallet e moeda do `balance_amount`).
- `wallet_ledger_entries`: uma `currency` compartilhada por `money_amount`, `balance_before_amount` e `balance_after_amount`.
- `wager_transactions`: uma `currency` para o `money_amount`.

**Motivação**: a seção 6.1 permite explicitamente `amount`/`currency` em colunas separadas, e a seção 4 exige que o mapeamento do `Money` seja justificado aqui — não exige moeda duplicada por campo. Guardar a moeda mais de uma vez na mesma linha criaria um estado representável no banco (ex: "moeda do débito diferente da moeda do saldo antes") que é impossível pelo domínio — o mesmo princípio de "tornar estado ilegal irrepresentável" que já aplicamos em `Money.assertSameCurrency`, agora no schema em vez de só em runtime.

**Reidratação**: cada `Money` é reconstruído combinando a coluna de valor específica com a `currency` compartilhada da linha — ex.: `Money.from({ amount: row.money_amount, currency: row.currency })`.

**Considerado, não decidido**: reforçar isso com uma foreign key composta `(wallet_id, currency) → wallets(id, currency)` na `wallet_ledger_entries`, exigindo `UNIQUE(id, currency)` em `wallets`. Registrado como pendente no final deste documento — nunca chegou a ser implementado, mesmo com o restante do schema completo.

## Tabela `wallets` — tipos e constraints

**`balance_amount numeric(19, 2)`**: `NUMERIC` é o único tipo nativo do Postgres com precisão decimal exata (não é ponto flutuante binário como `real`/`double precision`), e ainda permite operações agregadas em SQL (`SUM`, comparações) que serão necessárias na reconciliação (seção 9). A escala 2 casa com o `toFixed(2)` do `Money`.

**Ressalva testada**: se um valor com mais de 2 casas decimais chegasse até essa coluna, o Postgres **arredonda silenciosamente** em vez de rejeitar (testado: `10.987` virou `10.99`). Isso não é um risco na prática porque `Money.from()` já rejeita esse valor antes de qualquer query chegar ao banco — a constraint aqui é defesa em profundidade, não a validação primária.

**`CHECK (balance_amount >= 0)`**: testado contra inserção direta de saldo negativo — rejeitada pelo Postgres independente do que a camada de aplicação decida. É essa constraint que torna "saldo negativo causado por race" estruturalmente impossível, não apenas improvável.

**Lock pessimista provado com Postgres real**: rodei duas transações concorrentes de verdade (não simulação) — sessão A trava a wallet com `SELECT ... FOR UPDATE` e segura por 4s; sessão B tenta travar a mesma linha 1s depois. A query da sessão B levou ~3s pra retornar (exatamente o tempo restante do lock da A), confirmando que o bloqueio é real, não teórico.

## Tabela `wallet_ledger_entries` — imutabilidade em duas camadas

**Decisão**: `REVOKE UPDATE, DELETE` da role `app_user` **e** um trigger `BEFORE UPDATE OR DELETE` que lança exceção — as duas técnicas juntas, não uma ou outra.

**Pesquisa**: não há regra explícita no desafio sobre o mecanismo (só a exigência de que a imutabilidade esteja no schema — seção 5). Uma thread de 2008 na lista oficial `pgsql-sql` do PostgreSQL e um artigo recente sobre ledgers auditáveis em Postgres convergem na mesma recomendação: revogar privilégio é o controle real (a role da aplicação literalmente não consegue emitir o comando), e o trigger é defesa em profundidade — protege contra uma re-concessão futura por engano e contra o próprio dono da tabela, que por definição do Postgres ignora `GRANT`/`REVOKE`.

**Provado com Postgres real**: testei as duas camadas separadamente.
- Como `app_user` (role da aplicação, sem `UPDATE`/`DELETE` concedido): `UPDATE`/`DELETE` falharam com `permission denied` — nem chegaram a executar.
- Como `postgres` (dono da tabela, que ignora `REVOKE`): a tentativa passou pela checagem de privilégio, mas o **trigger** interceptou e lançou a exceção antes de qualquer mutação. A linha permaneceu intacta nos dois casos.

**Escopo**: essa trava é exclusiva da `wallet_ledger_entries`. As demais tabelas (`wallets`, `wager_transactions`, `inbox_messages`, `outbox_messages`) precisam de `UPDATE` normal e recebem `app_user` com CRUD completo.

**Constraint extra**: `wle_arithmetic_balanced_ck` espelha `WalletLedgerEntry.isBalanced()` do domínio como `CHECK` de banco — `balance_after = balance_before ± money` conforme a direção, validado na própria linha. Um `INSERT` malformado (fora da aplicação) não consegue gravar um lançamento desbalanceado.

**`direction text` + `CHECK`, não `ENUM` nativo**: enums nativos do Postgres são dolorosos de evoluir (adicionar um valor exige `ALTER TYPE` com restrições transacionais). `text` + `CHECK` dá a mesma garantia com uma migration trivial se precisar mudar.

## Tabela `wager_transactions` — regras de negócio como constraints de banco

**Índices únicos parciais pra "não reverter duas vezes pelo mesmo tipo"**: em vez de checar isso só na aplicação (que teria uma janela de corrida entre o SELECT de verificação e o INSERT), a regra virou dois índices únicos parciais — um pra `REFUND`, um pra `ROLLBACK` — cada um `UNIQUE (reference_transaction_id) WHERE kind = '<X>' AND status = 'PROCESSED'`. O filtro por `status = 'PROCESSED'` é essencial: uma tentativa que terminou `REJECTED`/`FAILED` não deve "gastar" a trava — só testei isso e confirmei (caso 15 dos testes).

**`wt_reference_policy_ck`**: mesma política de referência por `kind` que já está em `referencePolicyFor()` no domínio (`WagerTransaction`), replicada como `CHECK` — obrigatória p/ REFUND/ROLLBACK, proibida p/ BET/LOSS/OPENING, livre p/ WIN.

**Consistência `processed_at`/`failure_code` vs `status`**: dois `CHECK` garantindo que `processed_at` só existe quando `status = PROCESSED`, e `failure_code` só existe quando `status` é `REJECTED` ou `FAILED`. Evita um estado inconsistente entrar via SQL direto, mesmo que a aplicação sempre escreva os dois juntos corretamente.

**Reaproveitamento de índice**: `UNIQUE (provider_id, external_transaction_id)` serve duas funções — é a constraint de unicidade da identidade externa da transação, e é o mesmo índice usado pra resolver uma referência (`REFUND`/`ROLLBACK` procuram por `provider_id` + `reference_external_transaction_id`, que têm exatamente essa forma). Não precisou de índice adicional.

**`wt_pending_reference_idx`**: índice parcial só nas linhas `PENDING_REFERENCE`, ordenado por `created_at`, pro worker da seção 7.1 escanear só o que precisa reprocessar em vez de varrer a tabela toda.

**Testado**: 15 casos contra Postgres real, incluindo o cenário de uma BET receber REFUND processado + ROLLBACK processado (permitido, tipos diferentes) e uma segunda tentativa de REFUND na mesma referência (rejeitada pelo índice único parcial).

## Tabelas `inbox_messages` e `outbox_messages`

**`inbox_messages` sem id sintético**: chave primária composta `(message_id, consumer_name)` — é a própria chave de dedup exigida pela seção 10, não precisa de UUID adicional.

**Triggers de "uma transição só"**, diferente do trigger *append-only* do ledger: aqui permitimos exatamente uma atualização legítima (`processed_at`/`published_at` saindo de `NULL`) e bloqueamos qualquer mutação depois disso — espelha `InboxAlreadyProcessedError` e `OutboxAlreadyPublishedError` do domínio como triggers de banco.

**Correção**: os grants de `app_user` para `wallets` e `wager_transactions` tinham ficado de fora nas mensagens anteriores (só `wallet_ledger_entries` tinha sido tratada). Corrigido: `SELECT, INSERT, UPDATE` em todas as tabelas, `DELETE` em nenhuma — o domínio nunca deleta wallet, transação, inbox ou outbox, então a role da aplicação não recebe esse privilégio em lugar nenhum (princípio do menor privilégio).

**Concorrência do outbox publisher — `SKIP LOCKED`, não `FOR UPDATE` puro**: a wallet usa `FOR UPDATE` porque queremos **serializar** (a segunda transação deve esperar a primeira). O outbox publisher precisa do oposto — **distribuir** trabalho entre workers concorrentes sem que um espere o outro. `SELECT ... FOR UPDATE SKIP LOCKED` resolve isso: cada worker pula linhas já travadas por outro em vez de esperar.

**Provado com Postgres real**: dois workers concorrentes contra 3 mensagens pendentes. Worker A trava 2 linhas e segura por 3s; Worker B, iniciado 0.5s depois, roda a mesma query e retorna em **0.8ms** (nem chega perto de esperar), pegando só a 1 linha que sobrou. Nenhuma linha foi pega por dois workers ao mesmo tempo, nenhum worker ficou bloqueado.

## MikroORM v7 — mudança de API (importante)

**Descoberta ao testar**: o MikroORM v7 moveu os decorators clássicos (`@Entity`, `@PrimaryKey`, `@Property`) pra um pacote separado (`@mikro-orm/decorators/legacy`) — não vêm mais de `@mikro-orm/core`. A forma recomendada agora é `defineEntity` + o builder `p`, com inferência de tipo completa. Adotamos `defineEntity` como padrão do projeto.

**Efeito colateral bom**: `defineEntity` não usa decorators, então **não precisamos configurar `experimentalDecorators`/`emitDecoratorMetadata`** no `tsconfig.json` nem depender de `reflect-metadata` (que o v7 removeu como dependência obrigatória do core).

**`defineEntity` suporta `checks` e `triggers` nativamente**, gerenciados pelo schema generator/migrations automaticamente — validado contra Postgres real (`WalletEntity` com 3 `CHECK` constraints, incluindo a regex de moeda, foi criada e aplicada corretamente pelo `orm.schema.create()`). Isso significa que, pras tabelas com trigger de imutabilidade (`wallet_ledger_entries`, `inbox_messages`, `outbox_messages`), vamos poder declarar o trigger direto na entidade em vez de escrever migration SQL manual — a explorar quando chegarmos nelas.

**Validado com Postgres real, ciclo completo**: `WalletEntity` (banco, via MikroORM) → `Wallet.rehydrate()` (domínio) → `wallet.debit()` → `applyWalletToEntity()` (volta pra entidade) → `em.flush()`. Saldo `100.00` → debit de `30.00` → banco confirma `70.00`, `version` 1→2, exatamente como o domínio calculou. `balanceAmount` trafega como `string` em todo o caminho (nunca `number`) — confirmado via `typeof`.

**Separação Entity/Domínio mantida**: `WalletEntity` (em `infrastructure/persistence/entities/`) é só formato de dados pro MikroORM; `walletToDomain()`/`applyWalletToEntity()` (em `wallet.mapper.ts`) fazem a conversão. O domínio (`Wallet`) continua sem importar nada de `@mikro-orm/*`.

## WalletLedgerEntryEntity — triggers e checks nativos substituem o SQL manual

**Validado contra Postgres real**: a entidade declara os mesmos 4 `CHECK` que escrevemos à mão (`wle_money_positive_ck`, `wle_balance_before_non_negative_ck`, `wle_balance_after_non_negative_ck`, `wle_arithmetic_balanced_ck`) e o trigger de imutabilidade (`wle_immutable`, `BEFORE UPDATE OR DELETE`) via `triggers` do `defineEntity` — 5 casos testados: lançamento balanceado aceito, aritmética errada rejeitada pelo check, `UPDATE` bloqueado pelo trigger, `DELETE` bloqueado pelo trigger, linha original intacta depois das duas tentativas.

**`direction` via `p.enum()`**: o MikroORM gera `text` + `CHECK ... IN (...)` por padrão no Postgres (não enum nativo) — bate exatamente com a decisão que já tínhamos tomado à mão. Ressalva: o nome dessa constraint específica é auto-gerado pelo MikroORM (não dá pra customizar via `p.enum()`), então diverge do nome `wle_direction_ck` que usamos no SQL manual — funcionalmente idêntico, só o nome muda.

**Erro corrigido**: a primeira versão da entidade duplicava o enum `LedgerDirection` localmente (achando que evitava acoplamento com o domínio). Isso não só era desnecessário — importar um enum do domínio na infraestrutura é a direção de dependência permitida na arquitetura hexagonal — como causou um erro real de tipo no mapper (`LedgerDirectionColumn` e `LedgerDirection` são nominalmente diferentes pro TypeScript mesmo com os mesmos valores). Corrigido reaproveitando o enum do domínio diretamente na entidade.

**`wallet_id` via `p.manyToOne(WalletEntity).mapToPk()`**: gera a foreign key de verdade no schema, mas o valor em runtime na entidade é a `string` (uuid) pura — não um objeto `Wallet` carregado. Isso combina o melhor dos dois mundos: constraint de integridade referencial no banco, sem forçar um `populate` desnecessário toda vez que só precisamos do id.

**Mapper assimétrico**: diferente do `wallet.mapper.ts` (que tem `walletToDomain` E `applyWalletToEntity`, porque `Wallet` muda), o `walletLedgerEntry.mapper.ts` só tem `walletLedgerEntryToDomain` (ler) e `walletLedgerEntryToEntityData` (criar) — não existe "aplicar mudança", porque `WalletLedgerEntry` nunca é atualizado. A forma do mapper reforça a mesma imutabilidade que o trigger garante no banco.

## WagerTransactionEntity — índices únicos parciais auto-referenciados

**Validado contra Postgres real**, 5 casos: BET válido aceito, BET com referência rejeitado pelo `wt_reference_policy_ck`, primeiro REFUND processado numa BET aceito, segundo REFUND processado na mesma referência rejeitado pelo índice único parcial, ROLLBACK processado na mesma referência aceito (tipo diferente).

**A trava de "não reverter duas vezes" via `where` no `uniques`**: o MikroORM aceita um objeto `FilterQuery` (mesmo formato de `em.find()`) como predicado do índice — `where: { kind: WagerTransactionKind.Refund, status: WagerTransactionStatus.Processed }` — e traduz pro `WHERE "kind" = 'REFUND' AND "status" = 'PROCESSED'` do Postgres. Isso vale inclusive com auto-referência (`referenceTransaction` aponta pra linha da própria tabela) — funcionou de primeira, apesar do changelog do MikroORM mostrar que esse cenário específico já teve bug corrigido antes, o que reforçou testar com cuidado.

**FK auto-referenciada com `ON DELETE SET NULL` automático**: o MikroORM escolheu esse comportamento por padrão pra `referenceTransaction` (nullable), sem eu pedir. Como o domínio nunca deleta `WagerTransaction`, isso nunca dispara na prática — aceitando o padrão em vez de forçar `NO ACTION`.

**Armadilha de sandbox, não do MikroORM**: ao testar, bati em `relation already exists` repetidas vezes porque reaproveitei os mesmos nomes de constraint/índice (`wt_idempotency_key_uq` etc.) entre a tabela `wager_transactions` criada à mão numa sessão anterior e a nova tabela gerenciada pela entidade — nomes de índice no Postgres são únicos **por schema**, não por tabela. Tive que derrubar a tabela manual antiga pra liberar os nomes. Vale lembrar disso quando for migrar do SQL manual pro schema gerenciado pela entidade de vez.

## InboxMessageEntity e OutboxMessageEntity — trigger condicional e chave composta

**Validado contra Postgres real**, 6 casos: PK composta (`messageId` + `consumerName`, sem id sintético) funcionou sem configuração especial — só marcar as duas properties como `.primary()`. Trigger condicional (`IF OLD.processedAt IS NOT NULL THEN RAISE EXCEPTION...`) permitiu a primeira transição e bloqueou a segunda, nos dois casos (inbox e outbox) — confirma que o `triggers` do `defineEntity` aceita lógica condicional sobre `OLD`, não só um `RAISE EXCEPTION` incondicional como no ledger.

**`p.json()` mapeia pra `jsonb`** no Postgres por padrão (não `json` simples) — confirmado round-trip: grava um objeto JS, volta um objeto JS (`typeof === 'object'`), sem passar por serialização manual em nenhum lado.

**Cast necessário no mapper**: `p.json()` é tipado como `unknown` pelo MikroORM (ele não sabe a forma do JSON de antemão), mas `OutboxMessage.rehydrate()` espera `Readonly<Record<string, unknown>>`. Resolvido com um cast explícito e estreito no mapper — aceitável porque só a aplicação escreve nessa coluna, sempre no formato do envelope de `IntegrationEvent.toJSON()`.

**Índice parcial com `where: { publishedAt: null }`**: o formato `FilterQuery` do MikroORM aceita `null` como valor e traduz pra `IS NULL` no Postgres — mesmo padrão usado nos índices únicos parciais da `wager_transactions`, agora confirmado também pra `IS NULL` puro (sem comparação de igualdade com string).

**Com isso, as 5 entidades estão completas e validadas**: `WalletEntity`, `WalletLedgerEntryEntity`, `WagerTransactionEntity`, `InboxMessageEntity`, `OutboxMessageEntity` — todas via `defineEntity`, todas com checks/triggers/índices nativos reproduzindo exatamente as constraints que desenhamos à mão no schema, sem precisar de uma migration SQL manual separada pra nenhuma delas.

## mikro-orm.config.ts e a migration inicial

**`mikro-orm migration:create` gerou a migration completa a partir das 5 entidades** — testado contra Postgres real: `migration:up` cria as 5 tabelas com todas as constraints/triggers/índices, `migration:down` reverte tudo, `migration:up` de novo reaplica sem erro. Reversibilidade (seção 4) confirmada na prática, não só por leitura do código.

**`--initial` omite `down()` de propósito** (não haveria pra onde reverter); o `migration:create` normal gera os dois lados do diff. Usamos a versão normal.

**Descoberta importante: migrations e runtime precisam de roles diferentes.** `app_user` foi desenhado com privilégio mínimo desde o início (seção sobre `wallet_ledger_entries`) — e isso significa, por construção, que ele **não tem DDL** (`CREATE TABLE`, `CREATE INDEX`, `GRANT`). Tentei rodar a migration como `app_user` e recebi `permission denied for schema public`, exatamente como esperado de uma role de privilégio mínimo bem desenhada. A migration precisa rodar com uma role diferente — o dono do banco em dev, uma role `migrator` dedicada em produção. Documentado no `.env.example`.

**`GRANT`/`REVOKE` do `app_user` viraram parte da migration** (adicionados manualmente ao final do `up()`, depois de todas as tabelas existirem — o MikroORM não infere isso a partir das entidades, porque roles/privilégios não são modelados por elas). `CREATE ROLE app_user` em si **não** está na migration — é infraestrutura de cluster (persiste entre bancos), não schema; fica pendente pro init script do Postgres no Docker Compose.

**Confirmado end-to-end**: depois do ciclo completo (`up` → `down` → `up`), conectei como `app_user` de verdade e inseri uma wallet com sucesso — a role, os grants e o schema sobrevivem ao ciclo de migração intactos.

## Limitação conhecida: CLI de migration do MikroORM (Windows + Node 24)

**Problema**: `mikro-orm migration:up`/`down` falha com `TypeError: Cannot add property extensions, object is not extensible`, dentro de `loadOptionalDependencies` (`@mikro-orm/core/MikroORM.js`). Reproduzido no ambiente real do projeto (Windows, Node v24.20.0, Bun 1.4.0).

**Investigação**: testado sistematicamente — não é falta de dependência (`tsx` presente), não é conflito de loader (forçar `tsx` explicitamente não mudou o resultado), não é mismatch de versão entre pacotes `@mikro-orm/*` (todos em `7.1.14`, confirmado). O comum aos ambientes onde falha é rodar via CLI no Windows com Node 24 (que trouxe suporte nativo a TypeScript, ligado por padrão). Não consegui reproduzir num sandbox Linux + Node 22, então a causa raiz exata (Windows especificamente? interação do type-stripping nativo do Node 24 com o carregador de config do CLI?) ficou sem confirmação definitiva — não vale a pena aprofundar mais, já que existe um contorno funcional.

**Contorno adotado**: `scripts/migrate.ts` — um script pequeno que chama a API do MikroORM programaticamente (`MikroORM.init(config)` + `orm.migrator.up()`/`.down()`/`.create()`), no mesmo padrão já validado extensivamente ao longo deste projeto. Isso evita por completo a lógica interna de auto-configuração do CLI (`CLIHelper.getConfiguration`) que está com problema — o resto do MikroORM (entidades, `EntityManager`, o próprio `Migrator`) funciona normalmente. Testado com sucesso no ambiente real do usuário: ciclo `up` → `down` → `up` completo.

**Efeito colateral positivo**: o script também cobre `create`, então nem precisamos do CLI (`@mikro-orm/cli`) pra nada — só `@mikro-orm/migrations` é necessário como dependência.

**Descoberta lateral, não-bug**: `migrator.create()` pode gerar uma migration "fantasma" mesmo sem mudança real de schema — o Postgres reescreve internamente `CHECK (col IN (...))` como `CHECK (col = ANY (ARRAY[...]))`, e o MikroORM detecta essa diferença textual como uma mudança. É uma migration inofensiva (drop + recria a mesma constraint com sintaxe equivalente), mas vale revisar o diff antes de aplicar `create` no futuro, em vez de aceitar cegamente.

**Confirmado no ambiente real do usuário** (Windows, Bun 1.4.0, Node 24.20.0, Postgres local): `bun run migration:up` aplicou as 5 tabelas com todas as constraints/triggers/grants com sucesso via `scripts/migrate.ts`. A causa raiz de todos os erros anteriores nessa sessão de debug não foi o `Migrator`/CLI em si (hipótese descartada) nem versão do Node — foi uma cadeia de problemas de ambiente comuns e banais: `.env` salvo com 0 bytes (conteúdo nunca foi gravado de verdade), depois nome de banco divergente (`jungle` vs `jungle_gaming`) e tabelas residuais de sessões anteriores de teste manual com SQL cru no mesmo banco. Vale de lição: sempre confirmar `Get-Content -Raw .env` antes de assumir que variáveis de ambiente estão carregando.

## UnitOfWork — fronteira transacional explícita, sem decorator

**Decisão**: `UnitOfWork.transactional<T>(work: () => Promise<T>): Promise<T>` como porta pura — o domínio e os use cases nunca importam `EntityManager` nem qualquer API do MikroORM. Escolhida em vez de um decorator tipo `@Transactional()` por ser mais portável e deixar a fronteira transacional visível na própria assinatura do use case, sem mágica escondida.

**Validado contra Postgres real**: dois "repositórios" fake, cada um construído só com uma referência à `EntityManager` raiz (nunca uma fork manual passada explicitamente — exatamente como o NestJS injetaria via DI), chamados de dentro de `unitOfWork.transactional()`. Commit uniu as duas escritas; lançar uma exceção no meio reverteu as duas juntas. Isso confirma que `em.transactional()` do MikroORM propaga a transação via `RequestContext` (armazenamento assíncrono ambiente) — a implementação concreta (`MikroUnitOfWork`) pode usar esse mecanismo internamente sem que o use case saiba ou dependa disso.

## NestJS + Bun: emitDecoratorMetadata

**Descoberta**: rodar um teste de DI do NestJS via `tsx` (que usa esbuild) falhou silenciosamente — a instância injetada veio `undefined`. Isso é uma limitação conhecida do esbuild com `emitDecoratorMetadata` (a metadata `design:paramtypes` que o NestJS usa pra saber o que injetar em cada construtor), não um problema do NestJS em si. Compilando com `tsc` de verdade, funcionou.

**Bun tem suporte nativo a isso desde a v1.0.3**, adicionado especificamente pra fazer o NestJS funcionar sem configuração extra — confirmado pelo changelog oficial do Bun e reafirmado por fontes de 2026. Ainda assim, não tenho Bun no meu ambiente de teste pra confirmar 100% — pedido ao usuário rodar um smoke test (`smoke-nest-di.ts`) no ambiente real antes de seguir construindo sobre NestJS.

**tsconfig.json precisou de `experimentalDecorators`/`emitDecoratorMetadata`** — diferente do MikroORM (`defineEntity` não precisa disso), o NestJS 12 (atual) ainda usa decorators clássicos + `reflect-metadata` como peer dependency.

**Confirmado no ambiente real do usuário**: `bun run smoke-nest-di.ts` imprimiu `OK: DI do NestJS funcionou via Bun` — a injeção de dependência do NestJS funciona corretamente sob o transpilador nativo do Bun, exatamente como o changelog da v1.0.3 promete. A fundação de DI do projeto está validada; podemos construir a camada de aplicação (use cases) com confiança sobre ela.

## Repositórios — padrão save() upsert vs create() only

**`WalletRepository.save()` e `WagerTransactionRepository.save()`** checam se a entidade já existe (`em.findOne`) antes de decidir entre criar ou aplicar mudanças — aproveitando o identity map do MikroORM (uma segunda busca pelo mesmo id, dentro da mesma transação, nunca dispara query nova). Justificativa: as duas agregados têm ciclo de vida "nasce, depois muda de estado" (`Wallet` abre e depois sofre débito/crédito; `WagerTransaction` nasce `PENDING` e depois vira `PROCESSED`/`REJECTED`/`FAILED`), então um único método cobre os dois casos sem o use case precisar saber qual é qual.

**`WalletLedgerEntryRepository` só tem `create()`** — sem `save()`/`update()`. Reflete a imutabilidade do agregado na própria forma da porta, mesmo padrão já usado no mapper.

**Validado contra Postgres real, fluxo completo do futuro `OpenWalletUseCase`**: `Wallet.open()` (saldo zero) → `wallet.credit()` (aplica os 1000.00 iniciais) → `WagerTransaction` kind `OPENING` marcada `PROCESSED` → os três persistidos via `UnitOfWork.transactional()`, usando três repositórios instanciados separadamente (simulando injeção do NestJS). Recarregado com uma `EntityManager` nova (fork diferente): saldo `1000.00`, `version` 2, transação `PROCESSED`, exatamente 1 lançamento `CREDIT` no ledger com `balanceAfter` batendo. `findByPlayerAndCurrency` confirmado como o mecanismo que o use case vai usar pra detectar wallet duplicada.

## OpenWalletUseCase — primeiro use case, primeira peça de application/

**Descoberta ao ler a seção 9 com atenção**: o exemplo de resposta mostra `"version": 1` mesmo abrindo a wallet com saldo inicial de `1000.00`. Isso significa que o lançamento do ledger da abertura **não pode** passar por `wallet.credit()` (que incrementaria a `version` pra 2) — `Wallet.open()` já define o saldo final na criação. O lançamento é criado direto via `WalletLedgerEntry.create()`, com `balanceBefore = Money.zero(currency)` e `balanceAfter = initialBalance`, fora do mecanismo de "movimento" da `Wallet`.

**`IdGenerator` como porta própria**: em vez do controller HTTP gerar os 3 ids que a abertura precisa (wallet, transação `OPENING`, lançamento) e passá-los pro use case, o use case injeta um `IdGenerator` e gera internamente — o controller não precisa saber quantos ids uma operação interna consome. Implementação usa `uuid` v7 (time-ordenado), já adotando a decisão que tínhamos adiantado lá atrás sobre paginação do ledger.

**Duas camadas contra wallet duplicada**: checagem otimista via `findByPlayerAndCurrency` (resposta rápida no caminho comum) + captura de `UniqueConstraintViolationException` do MikroORM como rede de segurança pra corrida entre requisições simultâneas — a `UNIQUE(player_id, currency)` do banco continua sendo a garantia final, a aplicação só evita expor um erro feio de banco quando dá pra prever.

**Validado com Postgres real, via DI real do NestJS** (`Test.createTestingModule`, não instanciação manual): saldo positivo → 1 `WagerTransaction` OPENING + 1 lançamento CREDIT, `version` fica 1; saldo zero → nem transação nem lançamento são criados; segunda wallet pro mesmo `playerId`+`currency` → `WalletAlreadyExistsError`; mesmo player, moeda diferente → funciona normalmente.

**Nota de sandbox**: pra validar isso corretamente, tive que compilar com `tsc` de verdade em vez de rodar via `tsx` — o esbuild (usado pelo `tsx`) não emite `design:paramtypes` corretamente pra múltiplos parâmetros de construtor, e o `OpenWalletUseCase` injeta 5 dependências. Isso reforça a mesma limitação já documentada (Bun tem suporte nativo a isso; `tsx`/esbuild não).

## WageringModule e PersistenceModule

**`@mikro-orm/nestjs` (7.0.2) não suporta NestJS 12** — peer dependency exige `^11.0.5`. Confirmado via `npm install` sem `--silent` (`ERESOLVE unable to resolve dependency tree`); o Bun instala mesmo assim (mais permissivo com peer deps), mas isso não garante compatibilidade em runtime. Decisão: não usar o pacote oficial — `PersistenceModule` reproduz manualmente só o que precisávamos dele (inicializar o MikroORM uma vez, prover `EntityManager`, aplicar o middleware de `RequestContext` por requisição).

**Validado antes de escrever o módulo**: duas "requisições" concorrentes simuladas via `Promise.all`, cada uma isolada por `RequestContext.create()`, não corromperam o identity map uma da outra — cada uma só viu o que ela mesma salvou, e as duas persistiram corretamente.

**Descoberta ao testar o módulo**: o MikroORM lança `ValidationError` se código tentar usar a `EntityManager` "global" (não forkada) fora de um `RequestContext` — proteção ativa contra bug de concorrência entre requisições, não uma limitação chata. Isso significa que, com o middleware do `PersistenceModule` registrado no bootstrap da aplicação (`main.ts`, construído mais adiante), toda requisição HTTP ganha automaticamente sua própria `EntityManager` isolada — nenhum controller ou use case precisa se preocupar com isso manualmente.

**Validado com Postgres real, via `Test.createTestingModule({ imports: [WageringModule] })`** (módulo importado de verdade, não lista manual de providers): `OpenWalletUseCase` resolvido corretamente através da árvore de DI do módulo; execução dentro de um `RequestContext` simulado criou a wallet com sucesso.

## ProcessWagerTransactionUseCase — primeira fatia (BET)

**Escopo desta fatia**: só `BET`. `WIN`/`LOSS`/`REFUND`/`ROLLBACK` ficam para as próximas — o use case já rejeita explicitamente qualquer outro `kind` por enquanto (`UnsupportedKindError`), pra não fingir suporte que ainda não existe.

**`payloadHash`**: JSON canônico (chaves ordenadas, recursivo, `undefined` vira `null` explícito) + SHA-256. Testado: mesmo conteúdo com chaves em ordem diferente produz o mesmo hash; conteúdo diferente produz hash diferente.

**Saldo no replay é o observado no momento original, não o atual**: para uma transação `PROCESSED`, o saldo devolvido vem do `balanceAfter` do lançamento do ledger associado (via `WalletLedgerEntryRepository.findByTransactionId`, método novo) — não de uma nova leitura da wallet, que pode já ter mudado por operações posteriores. Testado explicitamente: uma segunda operação muda o saldo da wallet, e o replay da primeira continua retornando o saldo de quando ela foi processada.

**Duas camadas contra corrida de idempotência**: checagem otimista via `findByIdempotencyKey` (rápida, comum) + captura de `UniqueConstraintViolationException` como rede de segurança — se duas requisições com a mesma key passarem pela checagem ao mesmo tempo, a que perde a corrida no `INSERT` busca a transação "vencedora" e devolve a resposta dela como replay, em vez de vazar um erro de banco pro cliente.

**Rejeição por saldo insuficiente ainda assim commita a transação**: `WagerTransaction.reject()` é persistida normalmente (não é revertida pelo `catch`) — só a wallet e o ledger nunca são tocados, garantia que já vem da camada de domínio (`wallet.debit()` só muta estado depois de validar).

**Validado contra Postgres real, 16 casos, incluindo o cenário obrigatório da seção 8 com concorrência de verdade** (`Promise.all`, duas chamadas simultâneas ao `execute()`, não sequenciais): duas apostas de 80.00 sobre saldo 100.00 → exatamente uma `PROCESSED`, uma `REJECTED`, saldo final `20.00`, exatamente 1 lançamento de débito no ledger. Essa é a prova de ponta a ponta da garantia mais importante do desafio.

## ProcessWagerTransactionUseCase — segunda fatia (WIN, LOSS)

**Interpretação documentada sobre a referência opcional do `WIN`** (a seção 7 não deixa isso 100% explícito): quando informada, a referência é resolvida por `(providerId, referenceExternalTransactionId)` e validada por pertencimento (mesmo player, wallet, moeda, rodada) **se encontrada**. Três desfechos possíveis:
- Encontrada e pertence ao contexto certo → linka `referenceTransactionId`, processa normalmente.
- Encontrada mas de contexto errado (ex: rodada diferente) → `REJECTED` com `REFERENCE_MISMATCH` — é um erro de dado real, não silenciado.
- Não encontrada (ainda não chegou) → processa mesmo assim, sem linkar (best-effort). Diferente de `REFUND`/`ROLLBACK`, o efeito do `WIN` (creditar) não *depende* da referência existir — `ledgerDirectionFor()` do domínio já retorna `CREDIT` incondicionalmente pro `WIN`, sem precisar da referência pra decidir a direção.

**Bug real pego pelo teste, não hipotético**: `buildReplayResponse` assumia que toda transação `PROCESSED` tem lançamento associado no ledger — verdade pra `BET`/`WIN`, **falso** pra `LOSS` (que não afeta saldo, seção 6.4: "Operações sem efeito no saldo... não geram lançamento"). O teste de replay de `LOSS` expôs isso direto (lançava erro de "inconsistência" que não era real). Corrigido usando `existing.affectsBalance()` — método que já existe no domínio — como discriminador, em vez de inventar uma checagem nova.

**`LOSS` não usa lock pessimista**: como não muta a wallet, usa `findById` simples (sem `FOR UPDATE`) só pra confirmar que a wallet existe — lock pessimista é reservado pra quando existe uma mutação real a proteger.

**Validado contra Postgres real, 12 casos**: WIN sem referência, WIN com referência válida (linka corretamente), WIN com referência ainda não chegada (processa sem linkar), WIN com referência de rodada errada (rejeitado), LOSS (saldo intacto, zero lançamentos), replay idempotente de LOSS (sem o bug do ledger).

## ProcessWagerTransactionUseCase — terceira fatia (REFUND, ROLLBACK) — fecha o use case principal

**Checagem de "já revertida" é proativa, não reativa**: em vez de tentar o `INSERT` e capturar a violação do índice único parcial (`wt_unique_refund_per_reference_idx`/`wt_unique_rollback_per_reference_idx`), o use case consulta antecipadamente via `findProcessedReversalByReference`. Isso é seguro porque toda referência de REFUND/ROLLBACK pertence à mesma wallet (regra da seção 7: "deve pertencer ao mesmo... wallet"), e o lock pessimista já adquirido nela serializa qualquer tentativa concorrente de reverter a mesma referência — duas requisições nunca chegam a competir de verdade pelo índice único, uma sempre espera a outra soltar o lock da wallet primeiro. O índice do banco continua como rede de segurança contra um bug futuro no nosso próprio código, não como o mecanismo de correção principal.

**Cadeia de validação em ordem**, cada uma com seu próprio `failureCode`, usando um helper `rejectAndSave` pra evitar repetição:
1. Referência não encontrada → `PENDING_REFERENCE` (não é erro — fica pro worker de reprocessamento, seção 7.1, reprocessado com backoff exponencial; ver seção própria abaixo).
2. Referência encontrada mas não `PROCESSED` → `REFERENCE_NOT_PROCESSED`.
3. Referência de contexto diferente (player/wallet/moeda/rodada) → `REFERENCE_MISMATCH`.
4. Kind de referência não permitido (REFUND só aceita BET; ROLLBACK aceita BET/WIN/REFUND) → `REFERENCE_KIND_NOT_ALLOWED`.
5. Valor diferente do valor da referência → `REFERENCE_AMOUNT_MISMATCH`.
6. Já revertida pelo mesmo tipo de operação → `REFERENCE_ALREADY_REVERSED`.
7. Reversão causaria saldo negativo → `REVERSAL_WOULD_OVERDRAW` — **failureCode distinto** de `INSUFFICIENT_FUNDS` (mesma exceção de domínio, `InsufficientFundsError`, mas o use case decide qual código usar dependendo do `kind` que originou o débito, exatamente como planejado desde a mensagem sobre o domínio do `WagerTransaction`).

**Direção via `transaction.ledgerDirectionFor(reference)`**: reaproveita o método do domínio (já validado com 24 casos quando construímos `WagerTransaction`) — o use case não reimplementa a lógica de "BET debita, ROLLBACK inverte", só decide entre `wallet.credit()`/`wallet.debit()` com base no resultado.

**Validado contra Postgres real, 20 casos**: REFUND válido, segunda reversão do mesmo tipo rejeitada, ROLLBACK do mesmo alvo permitido (tipo diferente), `PENDING_REFERENCE` pra referência ainda não chegada, REFUND de WIN rejeitado (kind não permitido), ROLLBACK de WIN permitido (credit vira debit), valor errado, rodada errada, overdraw com failureCode distinto, e replay idempotente com saldo observado no momento original.

**Com isso, o `ProcessWagerTransactionUseCase` cobre todos os 5 kinds externos** (BET, WIN, LOSS, REFUND, ROLLBACK) — `OPENING` continua exclusivo do `OpenWalletUseCase`, nunca aceito aqui.

## Eventos de integração (outbox) — seção 11

**4 eventos concretos** (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`), cada um com sua própria `data` tipada e uma factory estática `from(...)` — mesmo padrão do exemplo da seção 11. O construtor de `IntegrationEvent` é `protected`; cada subclasse expõe seu próprio construtor `private` que só o `from()` da própria classe consegue chamar (protected é acessível de dentro da própria classe, incluindo métodos estáticos).

**`correlationId` provisório**: usa o id da própria `WagerTransaction` (ou da transação `OPENING`, no caso do `OpenWalletUseCase`) — ainda não temos um id de requisição/mensagem de entrada vindo da camada HTTP/SQS pra propagar. Revisitar quando essa camada existir.

**Quando cada evento dispara**, decidido por caminho no use case:
- `WagerTransactionProcessed` — toda vez que uma transação chega a `PROCESSED`, **inclusive `LOSS`** (que não gera `WalletBalanceChanged` junto, já que não mexe no saldo).
- `WagerTransactionRejected` — centralizado no helper `rejectAndSave`, cobrindo automaticamente todos os caminhos de rejeição do `BET`/`WIN`/`REFUND`/`ROLLBACK` sem precisar duplicar a chamada em cada um.
- `WagerTransactionPendingReference` — só no caminho de referência ainda não encontrada em `REFUND`/`ROLLBACK`.
- `WalletBalanceChanged` — só junto de um `WagerTransactionProcessed` que efetivamente mudou o saldo (`BET`, `WIN`, `REFUND`, `ROLLBACK`, `OPENING` com saldo inicial positivo).

**Replay idempotente nunca gera evento novo** — `buildReplayResponse` não chama `emitEvent` em lugar nenhum, testado explicitamente: repetir a mesma `Idempotency-Key` mantém a contagem de linhas na outbox inalterada.

**Validado contra Postgres real, 11 casos**: abertura com saldo positivo (2 eventos) e zero (0 eventos), `BET` válido (+2) e rejeitado (+1, só `Rejected`), `LOSS` (+1, só `Processed`), `REFUND` pendente (+1, `PendingReference`), replay (+0). Payload do `WalletBalanceChanged` conferido com o `balanceAfter` correto.

## main.ts e AppModule — bootstrap real da aplicação

**Validado de ponta a ponta**: `NestFactory.create(AppModule)` conecta no Postgres de verdade (descobre as 5 entidades via MikroORM), inicializa `PersistenceModule` e `WageringModule`, e fica escutando na porta configurada. Uma requisição HTTP real contra uma rota inexistente retornou `404` — confirma que o middleware do `RequestContext` (registrado no `PersistenceModule`, `forRoutes('*')`) intercepta o pipeline de requisição sem travar nada, mesmo sem nenhum controller ainda registrado.

**`@nestjs/platform-express` precisou ser instalado à parte** — não vem embutido no `@nestjs/core`, é peer dependency (mesmo padrão do `@nestjs/platform-express`/`@nestjs/microservices`/`@nestjs/websockets`, todos peer deps opcionais dependendo do que a aplicação realmente usa).

**Nota de sandbox durante o teste**: um processo em background morreu silenciosamente entre duas chamadas de shell separadas (a sessão pai encerrou e levou o filho junto) — não é um problema da aplicação, só uma armadilha de como processos em background se comportam entre invocações de comando isoladas. Resolvido rodando start+teste na mesma invocação.

## Controllers HTTP — seção 9

**Mapeamento de status de negócio → HTTP**, decidido explicitamente pra satisfazer a exigência de distinção clara da seção 9: `PROCESSED` → `200`; `REJECTED` → `422` (Unprocessable Entity — sintaticamente válido, rejeitado por regra de negócio); `PENDING_REFERENCE` → `202` (Accepted — aceito, processamento pendente). `POST /wallets` bem-sucedido usa `201` (Created). Validação de payload malformado → `400` (via `ValidationPipe` global, automático). Conflito de idempotência ou wallet duplicada → `409`.

**`class-validator`/`class-transformer` funcionam sob Bun** sem precisar de nenhum contorno adicional — mesma base de suporte a `emitDecoratorMetadata` que já validamos pro NestJS.

**`@IsUUID()` é estrito de verdade**: rejeitou UUIDs "fake" de teste tipo `d1000000-0000-0000-0000-000000000001` (usados em várias mensagens anteriores só pra preencher um formato) porque não têm os bits de versão/variante corretos de um UUID real. Isso não é bug — é a validação funcionando; os testes HTTP precisaram de UUIDs gerados de verdade (`crypto.randomUUID()`).

**`kind` no DTO exclui `OPENING` explicitamente** — a lista aceita é só `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, reforçando na borda da API a mesma regra que o domínio já impõe ("OPENING é interno, não pode ser submetido pela API").

**Validado com requisições HTTP reais** (app de pé, `curl` de verdade — não `Test.createTestingModule`): `POST /wallets` (201, depois 409 na duplicata), `POST /wagering/transactions` com `BET` válido (200), saldo insuficiente (422), header `Idempotency-Key` ausente (400), `REFUND` com referência pendente (202), e replay idempotente (200, `idempotentReplay: true`, mesmo `transactionId`).

**Pegadinha de teste, não da aplicação**: esqueci de rodar a migration no banco de teste antes do primeiro `curl` — deu `42P01` (tabela não existe). A aplicação sobe e conecta normalmente mesmo com o schema ausente; só falha na primeira query real. Lição: sempre migrar antes de testar contra um banco novo.

## Endpoints GET — completam a seção 9

**Paginação por keyset, não offset**: `GET /wallets/:walletId/ledger` usa um cursor opaco (base64url de `{createdAt, id}`) em vez de `?page=N`. Isso é o que garante estabilidade mesmo com inserções concorrentes durante a paginação — um `OFFSET 50` classicamente pula ou repete itens se linhas forem inseridas entre duas páginas; keyset não tem esse problema, porque a condição é sempre "itens depois deste ponto exato", não "a partir da posição N". Aproveita o mesmo índice `(wallet_id, created_at, id)` que já existia desde o desenho do schema.

**Validado contra Postgres real com dados de verdade**: paginação em 2 páginas (limit 2) sem pular nem repetir nenhum lançamento; `GET /wallets/:id` (200 e 404); `GET /wagering/transactions/:id` e `GET /providers/:providerId/wagering/transactions/:externalId` (ambos 200 com o objeto completo da transação, incluindo `referenceTransactionId`/`failureCode`).

**Presenter compartilhado** (`presentWagerTransaction`) entre os dois endpoints de consulta de `WagerTransaction` — mesma forma de resposta não importa se a busca foi por id interno ou por identidade externa do provedor.

## Outbox publisher worker — seção 11

**Fila nova, não a de entrada**: `wagering-events.fifo` (nome nosso) recebe os eventos de integração publicados — diferente de `wager-transactions.fifo` (seção 10), que é entrada de requisições dos provedores. O desafio não nomeia uma fila específica pra eventos de saída, então introduzimos uma própria. Env var: `WAGERING_EVENTS_QUEUE_URL`.

**`MessageDeduplicationId` explícito** (= id do próprio evento) e **`MessageGroupId` = `aggregateId`** (walletId) — não `ContentBasedDeduplication`, seguindo a decisão já registrada sobre o Docker Compose: a garantia real de dedup do lado de quem consome é a inbox dele, não a janela de 5 minutos do SQS. Agrupar por wallet mantém a ordem relativa dos eventos da mesma wallet sem serializar eventos de wallets diferentes entre si.

**`LockMode.PESSIMISTIC_PARTIAL_WRITE` do MikroORM gera `SELECT ... FOR UPDATE SKIP LOCKED`** — confirmado no SQL gerado antes de usar. É o equivalente via API do que validamos com SQL cru lá no desenho do schema da `outbox_messages`.

**Worker roda como processo separado** (`scripts/outboxWorker.ts`, mesmo padrão do `scripts/migrate.ts`) — um loop de polling com `NestFactory.createApplicationContext()` (contexto de aplicação sem HTTP), tratando `SIGTERM`/`SIGINT` pra encerrar graciosamente. `OutboxPublisherWorker.pollOnce()` é testável isoladamente, sem precisar do loop.

**Validado com Postgres real e SQS real** (não simulado em memória — usei `moto`, um mock leve de APIs da AWS via HTTP, já que o LocalStack de verdade agora exige conta/token mesmo pra uso community, e Docker não está disponível no meu sandbox): mensagem publicada aparece de fato na fila (não só marcada no banco); dois workers concorrentes (`Promise.all`, execução real simultânea) dividiram 5 mensagens pendentes sem nenhuma duplicata; falha ao publicar aciona `scheduleRetry()` com `attempts` incrementado e `nextAttemptAt` agendado.

## Consumidor SQS — seção 10

**Descoberta séria sobre transações aninhadas do MikroORM**: a seção 6.5 exige que inbox, mudança financeira, ledger e outbox participem da mesma transação SQL. A abordagem óbvia — o consumidor abrir sua própria `UnitOfWork.transactional()` por fora, envolvendo a chamada ao `ProcessWagerTransactionUseCase` (que já abre a dele por dentro) — foi testada e **provou ser não-confiável** nessa versão do MikroORM contra Postgres: `em.transactional()` aninhado não usa `SAVEPOINT`, emite um segundo `BEGIN` (que o Postgres ignora com aviso) e um `COMMIT` prematuro no fim do bloco interno, finalizando a transação inteira antes da hora. Tentei corrigir isso com detecção de aninhamento (via `isInTransaction()`, depois via `AsyncLocalStorage` próprio) — os resultados ficaram inconsistentes entre tentativas, e não cheguei a uma solução que eu pudesse provar robusta com confiança.

**Decisão pragmática, documentada com transparência**: em vez de arriscar uma "solução esperta" não comprovada, o consumidor usa um fluxo em **duas transações separadas**, não uma só:
1. Checa a inbox (leitura, sem transação) — se já processada, `ack` sem reprocessar.
2. Chama `ProcessWagerTransactionUseCase.execute()` normalmente — ele abre e comita sua própria transação completa (já validada extensivamente).
3. **Depois** que isso commitou, marca a inbox como processada numa transação própria e separada.
4. Só faz `ack` da mensagem no SQS depois que os dois passos acima tiverem sucesso.

Isso abre uma janela teórica entre os passos 2 e 3 (crash nesse meio-tempo deixaria a mudança financeira commitada mas a inbox não marcada) — mas essa janela é **segura na prática**: numa redelivery subsequente, a proteção por `idempotencyKey` da própria `WagerTransaction` (já validada exaustivamente) garante que o use case, chamado de novo, só devolve o resultado do replay, sem debitar/creditar a wallet outra vez. A marcação da inbox some sendo "curada" na segunda tentativa. **Validado explicitamente com um teste que simula esse exato cenário de crash** — chamando o use case direto (sem passar pelo handler, deixando a inbox propositalmente sem marcar) e depois "redelivering" a mesma mensagem pro handler: saldo não mudou, inbox foi corrigida.

**Categorização de erros** (seção 10): erros de negócio determinísticos (`WalletNotFoundError`, `IdempotencyConflictError`, `UnsupportedKindError`) → `ack` (retry não ajudaria, o erro se repetiria sempre); qualquer outro erro (ex: falha de conexão, exceção de driver) → `retry` (não faz `ack`, não marca inbox — deixa o SQS redeliverar via expiração da visibilidade, e o redrive policy da fila cuida da DLQ depois de esgotadas as tentativas).

**`sqsMessageId` usado pra dedup é o nativo do SQS** (`Message.MessageId` da resposta do `ReceiveMessageCommand`), não o campo `messageId` de dentro do corpo da mensagem — o nativo é o que permanece igual entre redeliveries da mesma mensagem física.

**Validado com Postgres real e SQS real (via `moto`)**: 12 casos, incluindo mensagem nova, redelivery idêntica, o cenário de crash acima, erro terminal, e erro transitório (usei um `walletId` malformado de propósito — gera uma exceção de driver genuína, não uma das nossas exceções de negócio catalogadas, testando a categorização real).

## Worker de reprocessamento de PENDING_REFERENCE — seção 7.1

**Backoff próprio, diferente do outbox**: mesmo formato (`2^attempts * base`, com teto), mas base de 5s e teto de 10min — maior que o do `OutboxMessage` (1s/5min). Justificativa: esperar uma transação relacionada do MESMO provider chegar depende do pipeline de entrega dele inteiro, não só do nosso outbox — uma janela mais generosa é razoável. Limite de 8 tentativas, dando uma janela total de ~20 minutos antes de desistir e rejeitar com `REFERENCE_NEVER_ARRIVED` (failure code novo).

**Refactor sem regressão**: extraí a validação completa de referência (pertencimento, kind permitido, valor exato, reversão dupla, aplicação do movimento) de `processReversal` para um método compartilhado (`applyReversalWithReference`) — usado tanto no processamento inicial quanto no retry do worker. A mesma cadeia de regras vale não importa QUANDO a referência é finalmente resolvida. Reconfirmado com os 20 casos de teste de `REFUND`/`ROLLBACK` já existentes, todos passando sem alteração depois do refactor.

**Query de busca não usa `SKIP LOCKED`, ao contrário do outbox** — decisão deliberada, não descuido: a correção aqui não depende disso, porque a mutação de verdade acontece dentro de `retryPendingReference()`, que já adquire lock pessimista na wallet e reconfirma `status === PENDING_REFERENCE` antes de fazer qualquer coisa. Dois workers pegando a mesma transação pendente no mesmo instante geram, no pior caso, trabalho redundante (um deles chega depois e só confirma que já foi resolvida) — nunca inconsistência.

**Validado contra Postgres real, 11 casos**: `PENDING_REFERENCE` inicial, reagendamento com backoff, respeito à janela de backoff (não tenta de novo antes da hora), resolução bem-sucedida quando a referência finalmente chega, e esgotamento do limite terminando em `REJECTED`.

## Bug real descoberto testando contra Docker/LocalStack de verdade

**`ValidationError: Using global EntityManager instance methods for context specific actions is disallowed`** — apareceu ao rodar `scripts/sqsConsumer.ts` contra o ambiente Docker real, na primeira leitura de inbox (`findByMessageIdAndConsumer`). Reproduzido e confirmado no meu sandbox antes de corrigir.

**Causa**: essa leitura acontece de propósito ANTES de qualquer `unitOfWork.transactional()` (pra não abrir uma transação inteira só pra checar "já processei essa mensagem?"). No caminho HTTP, isso nunca aparece porque o middleware do `PersistenceModule` embrulha toda requisição num `RequestContext` automaticamente. Os scripts de worker/consumidor (`scripts/*.ts`) nunca tiveram esse embrulho — cada um usa `NestFactory.createApplicationContext()`, que não passa por nenhum middleware HTTP.

**Por que `scripts/outboxWorker.ts` não tinha esse sintoma**: `OutboxPublisherWorker.pollOnce()` já tem sua primeira operação de banco DENTRO do próprio `unitOfWork.transactional()`, que estabelece o contexto ambiente sozinho — funcionava "por acidente", não por design deliberado. `scripts/pendingReferenceWorker.ts` tinha o mesmo problema do consumidor (a leitura de `findDuePendingReferences` também acontece antes de qualquer transação).

**Correção**: os três scripts agora pegam a instância do `MikroORM` do container (`app.get(MikroORM)`) e embrulham cada iteração de trabalho em `RequestContext.create(orm.em, ...)` — mesmo padrão do middleware HTTP, aplicado manualmente pra contextos sem requisição. Confirmado com um teste que reproduz o erro exato e depois valida a correção.

**Testado de ponta a ponta contra Docker + LocalStack reais** (não `moto`, não simulado): `POST /wallets` (HTTP real) → outbox gravada → `outboxWorker` publica de verdade na fila `wagering-events.fifo` → `scripts/sendTestMessage.ts` publica uma mensagem `BET` de verdade em `wager-transactions.fifo` → `scripts/sqsConsumer.ts` consome, checa inbox, checa idempotência, **trava a wallet com `SELECT ... FOR UPDATE`**, debita, cria a `WagerTransaction` `PROCESSED`, grava o lançamento no ledger, grava 2 eventos na outbox, comita tudo — e só então marca a inbox numa transação separada (exatamente o design de duas transações documentado acima) → `outboxWorker` publica os eventos novos de verdade em `wagering-events.fifo`. **Confirmado até o fim**: os 4 eventos totais (2 da abertura da wallet, 2 do `BET`) chegaram na fila com os payloads corretos, batendo exatamente com o que foi persistido no banco.

**`scripts/sendTestMessage.ts`**: script auxiliar novo, usa o SDK da AWS diretamente (não `awslocal` via shell) — evitou um problema real de escaping de JSON através de múltiplas camadas (PowerShell → `docker exec` → shell do container → Python/boto3) que causou uma mensagem malformada na primeira tentativa manual via `awslocal sqs send-message`. Passar a chamada pelo SDK/Node em vez de argumentos de shell eliminou o problema.

## DLQ/redrive testado contra LocalStack real

**`scripts/testDlqRedrive.ts`**: envia uma mensagem "envenenada" pra `wager-transactions.fifo`, recebe repetidamente sem confirmar (forçando redelivery imediata via `ChangeMessageVisibility(VisibilityTimeout: 0)`, sem esperar os 30s naturais do timeout de visibilidade), e confirma que ela migra pra `wager-transactions-dlq.fifo` depois de exatamente `maxReceiveCount` (5) tentativas — validando a configuração de redrive policy que criamos no script de init do LocalStack, não o código do consumidor em si (esse já foi testado separadamente).

**Validado primeiro contra `moto`, depois contra LocalStack real via Docker** — os dois bateram exatamente igual: 5 tentativas, na 6ª a fila principal já estava vazia, mensagem íntegra na DLQ.

## Worker de PENDING_REFERENCE testado contra Docker real

**Cenário completo, sem nenhuma intervenção manual além de submeter a transação que faltava**: `REFUND` submetido referenciando uma `BET` que ainda não existe → `PENDING_REFERENCE`. Worker rodando em paralelo: tentativa 1 (10s de backoff), tentativa 2 (20s), tentativa 3 (40s) — todas sem achar a referência, incrementando `reference_retry_attempts` e reagendando exatamente como projetado. No meio do caminho, a `BET` real chega via HTTP. Na tentativa seguinte do worker (a próxima já agendada, sem precisar de nova tentativa), ele acha a referência, valida pertencimento/kind/valor, aplica o crédito, marca `PROCESSED`, atualiza o saldo, grava o lançamento no ledger e os 2 eventos na outbox — tudo numa única transação, contra Postgres real no Docker.

## Health checks — GET /health/live e /health/ready

**Sem `@nestjs/terminus`**: os indicadores prontos do pacote são pra TypeORM, não MikroORM — precisaríamos escrever um indicador customizado de qualquer jeito, então implementei os dois endpoints diretamente, com controle total e sem dependência nova.

**Separação deliberada entre liveness e readiness**: `/health/live` nunca checa dependências externas — só confirma que o processo está respondendo. Isso importa porque um orquestrador (Kubernetes, por exemplo) usa liveness pra decidir se **reinicia o processo**; se ela checasse o Postgres, uma queda temporária do banco causaria reinícios desnecessários da aplicação, que nada tem a ver com o problema. `/health/ready` é quem decide se a instância deve **receber tráfego** — essa sim checa a conexão com o Postgres via `select 1`.

**Validado com falha real, não simulada**: subi a aplicação com Postgres saudável (`/health/ready` → 200), **parei o serviço do Postgres de verdade** com a aplicação já rodando, e confirmei que `/health/live` continuou 200 (não percebe a queda, como projetado) enquanto `/health/ready` corretamente virou 503 com `{"status":"error","checks":{"database":"error"}}`.

## Testes de integração formalizados — test/integration/

**Descoberta ao começar essa etapa**: quase todos os `test-*.ts` construídos ao longo da conversa inteira ficaram só no meu sandbox de validação — nunca foram entregues como arquivos do projeto. "Formalizar os testes" não é reorganização, é a primeira entrega real de testes de integração.

**`bun:test` não roda no meu sandbox** (só existe dentro do runtime do Bun) — validei a lógica com um shim próprio (usando o pacote `expect`, a mesma base do Jest com que `bun:test` é compatível) antes de entregar os arquivos reais com o import de `bun:test` de verdade. Mesmo padrão de validação-por-substituto já usado várias vezes nessa conversa.

**`test/integration/testSetup.ts`**: helper compartilhado — conecta no banco de teste, monta o módulo com todos os providers reais (não mocks, exceto `EventPublisher` que é fake pra não precisar de SQS nos testes de integração), cria/derruba o schema, e expõe `run()` (wrapper de `RequestContext.create()`) e `seedWallet()`. Todo teste de integração futuro reaproveita isso, evitando repetir o boilerplate que apareceu dezenas de vezes nos scripts ad-hoc anteriores.

**`concurrentBets.integration.test.ts`** — o cenário obrigatório da seção 8, agora como teste de verdade do projeto: duas apostas de 80 sobre saldo 100 (só uma processa), 50 apostas de 1.00 sobre saldo 30 (exatamente 30 processam), e 50 requisições **idênticas** em paralelo (mesma `idempotency key`) resultando em um único débito. Os três com `Promise.all` de verdade, não sequencial.

**Confirmado no ambiente real do usuário** via `bun test test/integration`: 3 de 3 passaram (`8 expect() calls`), batendo exatamente com a validação feita via shim antes da entrega.

**Mais 3 arquivos entregues** (15 testes adicionais, todos validados via shim antes da entrega): `openWallet.integration.test.ts` (saldo positivo/zero, duplicata, moedas diferentes), `wagerTransactionWinLoss.integration.test.ts` (WIN com/sem referência, mismatch de rodada, LOSS sem afetar saldo, replay de LOSS sem o bug do ledger que já documentamos), `wagerTransactionRefundRollback.integration.test.ts` (REFUND válido, dupla reversão rejeitada, ROLLBACK invertendo direção, kind não permitido, PENDING_REFERENCE, replay com saldo observado).

**Mais 3 arquivos entregues, fechando os testes de integração planejados**: `outboxEvents.integration.test.ts` (7 testes), `sqsConsumerHandler.integration.test.ts` (5 testes, incluindo o cenário crítico de crash simulado entre o use case e a marcação da inbox), `pendingReferenceWorker.integration.test.ts` (3 testes: reagendamento, resolução tardia, esgotamento).

**Bug pego no MEU teste, não no sistema**: o teste do outbox publisher assumia que uma única chamada a `pollOnce()` drenaria toda a fila pendente — mas como os testes anteriores do mesmo arquivo acumulam eventos não publicados no mesmo banco (todos dentro do mesmo `describe`, sem limpar entre testes), havia 17 pendentes na hora desse teste rodar, e `pollOnce()` só processa até `batchSize` (10) por chamada, sobrando 7. Corrigido fazendo o teste chamar `pollOnce()` em loop até drenar — o mesmo padrão que o worker real (`scripts/outboxWorker.ts`) já usa.

**33 testes de integração no total**, todos validados via shim antes da entrega, cobrindo: concorrência (seção 8, obrigatório), abertura de wallet, os 5 kinds de `WagerTransaction`, idempotência e replay, eventos de outbox, consumidor SQS/inbox (com o cenário de crash), e o worker de `PENDING_REFERENCE`.

**Confirmado no ambiente real do usuário**: `bun test test/integration` → 33 de 33 passaram (`68 expect() calls`, 7 arquivos de teste — `testSetup.ts` não conta, não tem sufixo `.test.ts`), batendo exatamente com a validação via shim.

## README.md e .env.example finalizados

**`README.md` criado** — ponto de entrada rápido do projeto (visão geral, como rodar, tabela de garantias mapeando cada regra do desafio à sua implementação, endpoints, estrutura, decisões técnicas notáveis). O `ARCHITECTURE.md` continua sendo o registro detalhado.

**Descoberta real ao revisar o `.env.example`**: estava desatualizado desde muito cedo na conversa — faltava `WAGERING_EVENTS_QUEUE_URL`, e os valores padrão não batiam com o que o usuário vinha usando na prática. Mais importante: **a aplicação nunca tinha sido testada rodando como `app_user`** (a role de privilégio mínimo) — o usuário sempre rodou tanto as migrations quanto a API com a role `postgres` (superusuário), contornando sem perceber todo o trabalho de privilégio mínimo feito desde o desenho do schema.

**Validado agora, de ponta a ponta, com a aplicação rodando como `app_user` de verdade**: `POST /wallets` (201, wallet criada), `POST /wagering/transactions` BET (200, saldo debitado corretamente `100→75`), e uma tentativa de `DELETE` direto na tabela `wallets` **corretamente bloqueada** (`permission denied for table wallets`) — confirma que os `GRANT`s da migration são suficientes pra operação real da aplicação E que a restrição de privilégio funciona na prática, não só na teoria.

**Nota de sandbox**: a primeira tentativa desse teste falhou com erro de autenticação — a role `app_user` já existia de uma sessão anterior desta mesma conversa (criada com outra senha), e meu `CREATE ROLE` falhou silenciosamente com "already exists" sem eu perceber de imediato. Corrigido com `ALTER ROLE ... WITH LOGIN PASSWORD ...` em vez de `CREATE ROLE`.

## Falha transitória de infraestrutura — 5ª categoria da seção 9, resolvida

**Descoberta ao investigar**: o MikroORM exporta uma hierarquia rica de exceções de driver (`ConnectionException`, `DeadlockException`, `LockWaitTimeoutException`, `ConstraintViolationException` e suas 4 subclasses, `SyntaxErrorException`, `TableNotFoundException` etc.) — todas descendem de `DriverException`. Um catch ingênuo em `instanceof DriverException` pegaria também violações de constraint e erros de sintaxe/schema, que são bugs de verdade ou regras de negócio, não falhas transitórias.

**Achado real e não óbvio, confirmado em teste**: uma falha de conexão crua (`ECONNREFUSED`, antes de qualquer handshake do protocolo Postgres) chega como a classe **base** `DriverException` pura — não como `ConnectionException`, que é mais específica. A distinção certa não é "é uma exceção do driver", é "o servidor processou a query e respondeu algo definitivo" (constraint, sintaxe, schema — não transitório) vs. "nem chegou a conversar com o servidor, ou teve contenção transitória" (conexão, deadlock, lock wait timeout — transitório).

**`isTransientInfrastructureFailure()`**: allowlist explícita — `ConnectionException`, `DeadlockException`, `LockWaitTimeoutException` via `instanceof`, mais `exception?.constructor === DriverException` (comparação de classe **exata**, não `instanceof`, pra pegar só a base pura sem capturar nenhuma das subclasses de `ServerException`). Validado com 3 casos reais: conexão recusada (transitório), violação de unicidade real (não transitório), tabela inexistente (não transitório).

**`TransientInfrastructureFailureFilter`**: estende `BaseExceptionFilter` do NestJS em vez de implementar `ExceptionFilter` do zero — intercepta só o caso transitório (`503`, corpo claro) e delega qualquer outra coisa (`HttpException` já mapeada, erro genuinamente inesperado) pro comportamento padrão do Nest via `super.catch()`. Essencial: sem essa delegação, um filtro `@Catch()` global quebraria todos os status codes já corretos (`400`/`404`/`409`/`422`).

**Validado com falha real, não simulada**: confirmei que `404` e `400` continuam funcionando exatamente como antes (teste de regressão) e, com a aplicação já rodando, **parei o serviço do Postgres de verdade** — a próxima requisição corretamente virou `503` com `{"statusCode":503,"error":"ServiceUnavailable","message":"Falha temporária de infraestrutura — tente novamente em instantes."}`.

## Taxonomia de FailureCode formalizada (seção 7.2)

**Requisito literal, revisitado com o usuário**: "Toda rejeição precisa carregar um `failureCode` estável e legível por máquina, suficiente para o provedor decidir se reenvia, corrige o payload ou desiste." Ter 8 valores de string estáveis não bastava — faltava a parte "suficiente pro provedor decidir".

**Insight de design**: nenhum `FailureCode` mapeia pra "reenvia sem mudar nada". Reenviar o mesmo payload com a mesma `idempotencyKey` só devolve a mesma rejeição de novo (replay, não uma nova avaliação) — a idempotência garante isso. "Reenvia" de verdade só faz sentido pra falha transitória de infraestrutura, que é um `503` completamente separado (`TransientInfrastructureFailureFilter`), nunca um `REJECTED` com `failureCode`. Por isso a taxonomia de ação tem só dois valores: `FIX_PAYLOAD` (algo no payload está errado, corrija e envie uma transação nova) e `ABANDON` (rejeição definitiva, não há payload que resolva).

**`src/wagering/domain/failureCode.ts`** (novo): `FailureCode` como união literal fechada dos 8 valores (não mais `type FailureCode = string`); `FAILURE_CODE_GUIDANCE` como mapa exaustivo `Record<FailureCode, { action, description }>`, com `satisfies` garantindo em tempo de compilação que todo código tem entrada — esquecer de mapear um `FailureCode` novo quebra o build, não vira bug silencioso em produção.

**Achado real ao implementar**: o `POST /wagering/transactions` nunca incluía `failureCode` na resposta imediata de uma rejeição (`rejectAndSave` não colocava o campo no objeto de retorno) — só dava pra ver fazendo um `GET /wagering/transactions/:id` separado depois. Isso violava a própria seção 7.2 na resposta que mais importa (a imediata). Corrigido, incluindo o caminho de **replay idempotente** (`buildReplayResponse`), que também precisa mostrar `failureCode`/`recommendedAction` — não só a primeira tentativa — já que o requisito diz "toda rejeição", e um replay ainda é a mesma rejeição sendo comunicada de novo.

**Também propagado**: o evento de domínio `WagerTransactionRejected` (para os providers que consomem via SQS/outbox, não só via HTTP síncrono) agora carrega `recommendedAction` junto com `failureCode`, e a factory `.from()` valida a invariante de que uma transação `REJECTED` sempre tem `failureCode` (lança erro se não tiver, em vez de um fallback silencioso `"UNKNOWN"` que existia antes).

**Validado de ponta a ponta contra Postgres real**: rejeição imediata (`422`, com `failureCode: "INSUFFICIENT_FUNDS"`, `recommendedAction: "ABANDON"`), replay idempotente da mesma rejeição (mesmos campos presentes), e `GET` da transação (idem) — e confirmado que os 33 testes de integração existentes continuam passando sem nenhuma regressão depois da mudança de tipo.

## Teste de carga (diferencial) — `bun run test:load`

**`scripts/loadTest.ts`**: três fases contra a API HTTP real (não chamadas de use case in-process — exercita o stack inteiro: roteamento do Nest, `ValidationPipe`, pool de conexão do MikroORM, locks do Postgres).

1. **Baseline**: 100 wallets com saldo alto, 2000 apostas de R$1,00 espalhadas entre elas, concorrência 50 — mede throughput e p50/p95/p99 com contenção mínima por construção.
2. **Contenção deliberada**: 5 wallets com saldo exato de R$100, 50 apostas de R$10 **simultâneas** (`Promise.all`, não sequencial) em cada uma — matematicamente só 10 por wallet podem ser aceitas; o relatório compara o resultado real contra o esperado (`processadas === esperado && rejeitadas === esperado && erros === 0`) e dá um veredito explícito de correção sob carga, não só sob os testes de integração em pequena escala.
3. **Lag da outbox**: consulta direta no banco (`occurred_at` vs `published_at` em `outbox_messages`) para os eventos gerados durante a janela do teste, com espera de até 20s (configurável) pro worker drenar.

**Bug real encontrado e corrigido durante a validação**: `CONTENTION_WALLET_BALANCE` e `CONTENTION_BET_AMOUNT` são números (`100`, `10`); `String(100)` produz `"100"`, não `"100.00"` — o DTO de criação de wallet exige exatamente 2 casas decimais e rejeitava com `400` antes mesmo do teste começar. Corrigido com `.toFixed(2)`.

**Validado no meu sandbox** (Postgres real, aplicação real compilada, outbox worker real — SQS não disponível no sandbox, então o lag foi validado separadamente): fase de contenção deu resultado **exato** (20/20 sucessos esperados, 20/20 rejeições esperadas, zero erros inesperados) rodando com concorrência de verdade via `Promise.all`, não sequencial. A query de lag da outbox foi validada à parte, com dados simulados de publicação (já que o worker publicando de verdade contra LocalStack foi extensivamente validado em sessões anteriores) — percentis corretos contra o range conhecido dos dados simulados.

**Honestidade do relatório, de propósito**: o markdown gerado inclui uma seção explícita de limitações (gerador de carga e sistema sob teste na mesma máquina, sem meta de RPS, poucas wallets de contenção de propósito — o objetivo é correção sob concorrência, não volume) — alinhado com o pedido do desafio de que "a qualidade do experimento e a honestidade da análise pesam mais que o número bruto".

## Resultado real do teste de carga — contra Docker + LocalStack

Rodado no ambiente real do usuário (Windows, Docker Desktop, Postgres + LocalStack via `docker-compose`), não no meu sandbox limitado.

- **Baseline**: 2000 requisições, 100% de sucesso, **0% de taxa de erro**, throughput 71.2 req/s, p50 692.8ms · p95 867.2ms · p99 968.1ms.
- **Contenção deliberada**: 50/50 sucessos esperados, 200/200 rejeições esperadas, **zero erros inesperados** — veredito exato, na escala completa (250 requisições simultâneas reais, não a versão reduzida validada no meu sandbox).
- **Lag da outbox**: 4510 eventos publicados (bate exatamente com a contagem esperada: 2×2000 da fase de baseline + os eventos de setup das wallets + da fase de contenção), 0 pendentes ao final — fila drenada por completo. p50 5762ms, p99 7899ms.

**Achado real e interessante, não um bug**: o lag da outbox parece alto à primeira vista, mas tem explicação matemática direta — o worker publica em lotes de **10 mensagens por `pollOnce()`** (o `batchSize` padrão), e a fase de baseline gravou ~4000 eventos em 28s (~140/s). O throughput de *escrita* superou o throughput de *drenagem* do worker durante a rajada, empilhando um backlog consumido nos segundos seguintes — consistência eventual funcionando exatamente como projetada, não imediata. A arquitetura já foi desenhada pra esse cenário: o `SKIP LOCKED` usado em `findPendingBatch` permite rodar múltiplos workers de outbox em paralelo sem duplicar publicação (já documentado e testado anteriormente), o que resolveria esse gargalo especificamente subindo o throughput de drenagem linearmente — não testado sob carga nesta rodada, mas é a mitigação natural que o design já suporta.

## Pendente de decisão / a formalizar

- Autenticação (seção 2) — decisão ainda não tomada.
- Foreign key composta `(wallet_id, currency) → wallets(id, currency)` na `wallet_ledger_entries` (ver seção "Mapeamento de Money no schema") — considerado, nunca decidido; reforçaria uma garantia que hoje já é verdade na prática (nenhum caminho do código grava moeda divergente), mas não está expressa como constraint.