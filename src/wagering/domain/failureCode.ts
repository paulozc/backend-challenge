/**
 * Taxonomia de FailureCode — seção 7.2.
 *
 * Requisito literal do desafio: "Toda rejeição precisa carregar um failureCode estável
 * e legível por máquina, suficiente para o provedor decidir se reenvia, corrige o
 * payload ou desiste."
 *
 * Um conjunto fechado de strings sozinho não é suficiente — o provedor integrador
 * precisaria manter, do lado dele, uma cópia da nossa lógica de negócio pra saber o que
 * cada código significa em termos de ação. Isso dessincroniza com o tempo. Em vez disso,
 * cada FailureCode tem uma RecommendedAction associada, exposta na própria resposta da
 * API (ver presenters/wagerTransaction.presenter.ts) — o provedor lê o campo, não
 * precisa adivinhar nem manter uma tabela paralela.
 *
 * Insight de design: nenhum FailureCode mapeia pra "reenvia sem mudar nada" (RETRY).
 * Reenviar o MESMO payload com a MESMA idempotencyKey só devolve a mesma rejeição de
 * novo — a idempotência garante isso. "Reenvia" de verdade só se aplica a falha
 * transitória de infraestrutura, que é um HTTP 503 completamente separado, nunca um
 * REJECTED com failureCode (ver TransientInfrastructureFailureFilter). Por isso as únicas
 * ações possíveis aqui são FIX_PAYLOAD (algo no payload está errado, corrija e envie uma
 * transação nova) e ABANDON (a rejeição é definitiva, não há payload que resolva).
 */

export const FailureCode = {
  InsufficientFunds: "INSUFFICIENT_FUNDS",
  ReferenceMismatch: "REFERENCE_MISMATCH",
  ReferenceNotProcessed: "REFERENCE_NOT_PROCESSED",
  ReferenceKindNotAllowed: "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceAmountMismatch: "REFERENCE_AMOUNT_MISMATCH",
  ReferenceAlreadyReversed: "REFERENCE_ALREADY_REVERSED",
  ReversalWouldOverdraw: "REVERSAL_WOULD_OVERDRAW",
  ReferenceNeverArrived: "REFERENCE_NEVER_ARRIVED",
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export type RecommendedAction = "FIX_PAYLOAD" | "ABANDON";

interface FailureCodeGuidance {
  action: RecommendedAction;
  /** Explicação curta, pensada pra quem está integrando o provedor — não pro usuário final. */
  description: string;
}

/**
 * Mapa exaustivo — o `satisfies Record<FailureCode, ...>` garante em tempo de
 * compilação que todo FailureCode tem uma entrada aqui; esquecer um novo código quebra o
 * build, não vira um bug silencioso em produção.
 */
export const FAILURE_CODE_GUIDANCE = {
  [FailureCode.InsufficientFunds]: {
    action: "ABANDON",
    description: "Saldo da wallet era insuficiente no momento da avaliação. Reenviar a mesma transação (mesma idempotencyKey) sempre devolve a mesma rejeição — não há payload que corrija isso.",
  },
  [FailureCode.ReferenceMismatch]: {
    action: "FIX_PAYLOAD",
    description: "A transação referenciada existe, mas não pertence à mesma rodada (roundId). Confira o roundId e o externalTransactionId referenciado antes de enviar uma nova transação.",
  },
  [FailureCode.ReferenceNotProcessed]: {
    action: "ABANDON",
    description: "A transação referenciada existe, mas não está PROCESSED (ela própria foi rejeitada ou falhou). Não há como reverter algo que nunca foi efetivado.",
  },
  [FailureCode.ReferenceKindNotAllowed]: {
    action: "FIX_PAYLOAD",
    description: "O tipo da transação referenciada não é permitido para este kind (ex: REFUND só pode referenciar BET). Confira qual transação está sendo referenciada.",
  },
  [FailureCode.ReferenceAmountMismatch]: {
    action: "FIX_PAYLOAD",
    description: "O valor informado não bate com o valor da transação referenciada. Corrija o valor e envie uma nova transação.",
  },
  [FailureCode.ReferenceAlreadyReversed]: {
    action: "ABANDON",
    description: "Já existe um REFUND ou ROLLBACK PROCESSED para essa referência. Reversão dupla não é permitida — não há payload que corrija isso.",
  },
  [FailureCode.ReversalWouldOverdraw]: {
    action: "ABANDON",
    description: "Reverter essa transação deixaria o saldo da wallet negativo. Indica inconsistência no histórico de operações — não é algo que o provedor resolve reenviando ou corrigindo o payload.",
  },
  [FailureCode.ReferenceNeverArrived]: {
    action: "FIX_PAYLOAD",
    description: "A transação referenciada nunca chegou, mesmo depois de todas as tentativas de reprocessamento. Confira se o externalTransactionId referenciado está correto e se a transação original foi genuinamente enviada.",
  },
} as const satisfies Record<FailureCode, FailureCodeGuidance>;

export function getFailureCodeGuidance(code: FailureCode): FailureCodeGuidance {
  return FAILURE_CODE_GUIDANCE[code];
}