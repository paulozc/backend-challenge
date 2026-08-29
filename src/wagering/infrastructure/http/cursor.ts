import { BadRequestException } from "@nestjs/common";
import type { LedgerCursor } from "../../ports/walletLedgerEntry.repository";

export function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })).toString("base64url");
}

export function decodeCursor(raw: string): LedgerCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || typeof parsed.id !== "string") {
      throw new Error("formato inválido");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException("cursor inválido");
  }
}