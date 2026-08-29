import { test, expect, describe } from "bun:test";

import { InboxAlreadyProcessedError, InboxMessage } from "../../inboxMessage";

describe("InboxMessage.receive", () => {
  test("nasce não processada", () => {
    const inbox = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-consumer",
      payloadHash: "hash1",
      receivedAt: new Date(),
    });

    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();
  });
});

describe("InboxMessage.markProcessed", () => {
  test("registra processedAt na primeira vez", () => {
    const inbox = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-consumer",
      payloadHash: "hash1",
      receivedAt: new Date(),
    });

    const at = new Date("2026-08-28T10:00:00.000Z");
    inbox.markProcessed(at);

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.getTime()).toBe(at.getTime());
  });

  test("chamar duas vezes lança InboxAlreadyProcessedError (protege contra reprocessamento)", () => {
    const inbox = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-consumer",
      payloadHash: "hash1",
      receivedAt: new Date(),
    });

    inbox.markProcessed(new Date());

    expect(() => inbox.markProcessed(new Date())).toThrow(
      InboxAlreadyProcessedError,
    );
  });
});

describe("InboxMessage.rehydrate", () => {
  test("reconstrói o estado processado sem revalidar", () => {
    const processedAt = new Date("2026-08-28T10:00:00.000Z");
    const inbox = InboxMessage.rehydrate({
      messageId: "msg-2",
      consumerName: "wager-consumer",
      payloadHash: "hash2",
      receivedAt: new Date("2026-08-28T09:00:00.000Z"),
      processedAt,
    });

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.getTime()).toBe(processedAt.getTime());
  });
});