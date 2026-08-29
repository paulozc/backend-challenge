import { Injectable } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { IdGenerator } from "../ports/idGenerator";

/** UUID v7 (time-ordenado) — relevante pro cursor de paginação do ledger (seção 9). */
@Injectable()
export class UuidV7IdGenerator extends IdGenerator {
  generate(): string {
    return uuidv7();
  }
}