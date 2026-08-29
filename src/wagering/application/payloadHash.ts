import { createHash } from "node:crypto";

/**
 * Serializa um valor em JSON canônico: chaves de objeto sempre em ordem alfabética,
 * recursivamente. Arrays mantêm a ordem original (ordem importa em arrays).
 * Garante que o mesmo conteúdo lógico sempre produz a mesma string, não importa
 * a ordem em que as chaves foram declaradas no objeto original.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null"; // undefined em campo opcional vira null explícito
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * payloadHash = SHA-256 do JSON canônico do subconjunto de campos de negócio.
 * O header Idempotency-Key e metadados de transporte NUNCA entram aqui (seção 9).
 */
export function computePayloadHash(businessFields: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(businessFields)).digest("hex");
}