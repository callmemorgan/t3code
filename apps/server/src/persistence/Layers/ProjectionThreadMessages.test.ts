import { MessageId, ResponseAnnotationId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("appends streaming text and applies attachment updates", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-streaming-append");
      const messageId = MessageId.make("message-streaming-append");
      const createdAt = "2026-02-28T19:05:00.000Z";
      const attachments = [
        {
          type: "image" as const,
          id: "thread-streaming-append-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.appendStreaming({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "hello",
        attachments,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.appendStreaming({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: " world",
        createdAt: "2026-02-28T19:05:01.000Z",
        updatedAt: "2026-02-28T19:05:01.000Z",
      });

      const rowWithPreservedAttachments = yield* repository.getByMessageId({ messageId });
      assert.equal(rowWithPreservedAttachments._tag, "Some");
      if (rowWithPreservedAttachments._tag === "Some") {
        assert.deepEqual(rowWithPreservedAttachments.value.attachments, attachments);
      }

      yield* repository.appendStreaming({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "",
        attachments: [],
        createdAt: "2026-02-28T19:05:02.000Z",
        updatedAt: "2026-02-28T19:05:02.000Z",
      });

      const row = yield* repository.getByMessageId({ messageId });
      assert.equal(row._tag, "Some");
      if (row._tag === "Some") {
        assert.equal(row.value.text, "hello world");
        assert.deepEqual(row.value.attachments, []);
        assert.equal(row.value.createdAt, createdAt);
        assert.equal(row.value.updatedAt, "2026-02-28T19:05:02.000Z");
        assert.isTrue(row.value.isStreaming);
      }
    }),
  );

  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect("round-trips response annotations and preserves them on streaming updates", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-response-annotations");
      const messageId = MessageId.make("message-response-annotations");
      const sourceMessageId = MessageId.make("assistant-response-source");
      const createdAt = "2026-02-28T19:20:00.000Z";
      const responseAnnotations = [
        {
          id: ResponseAnnotationId.make("annotation-1"),
          sourceMessageId,
          selectedText: "selected text",
          sourceRange: { start: 3, end: 16, prefix: "a ", suffix: " b" },
          comment: "Explain this.",
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "Please explain.",
        responseAnnotations,
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "Please explain more.",
        isStreaming: true,
        createdAt,
        updatedAt: "2026-02-28T19:20:01.000Z",
      });

      const row = yield* repository.getByMessageId({ messageId });
      assert.equal(row._tag, "Some");
      if (row._tag === "Some") {
        assert.deepEqual(row.value.responseAnnotations, responseAnnotations);
      }

      const turnId = TurnId.make("turn-response-annotations");
      yield* repository.upsert({
        messageId,
        threadId,
        turnId,
        role: "user",
        text: "Please explain more.",
        responseAnnotations,
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:20:02.000Z",
      });

      const rebound = yield* repository.getByMessageId({ messageId });
      assert.equal(rebound._tag, "Some");
      if (rebound._tag === "Some") {
        assert.equal(rebound.value.turnId, turnId);
        assert.deepEqual(rebound.value.responseAnnotations, responseAnnotations);
      }
    }),
  );

  it.effect("finds the user message bound to a turn without listing the thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-bound-turn");
      const turnId = TurnId.make("turn-bound");
      const createdAt = "2026-02-28T19:30:00.000Z";

      yield* repository.upsert({
        messageId: MessageId.make("user-unbound"),
        threadId,
        turnId: null,
        role: "user",
        text: "unbound",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.upsert({
        messageId: MessageId.make("assistant-bound"),
        threadId,
        turnId,
        role: "assistant",
        text: "assistant",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      const missing = yield* repository.getUserMessageByTurnId({ threadId, turnId });
      assert.equal(missing._tag, "None");

      yield* repository.upsert({
        messageId: MessageId.make("user-bound"),
        threadId,
        turnId,
        role: "user",
        text: "bound",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      const bound = yield* repository.getUserMessageByTurnId({ threadId, turnId });
      assert.equal(bound._tag, "Some");
      if (bound._tag === "Some") {
        assert.equal(bound.value.messageId, MessageId.make("user-bound"));
      }
      const otherThread = yield* repository.getUserMessageByTurnId({
        threadId: ThreadId.make("thread-other"),
        turnId,
      });
      assert.equal(otherThread._tag, "None");
    }),
  );

  it.effect("reports malformed response annotation JSON as a decode error", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const sql = yield* SqlClient.SqlClient;
      const messageId = MessageId.make("message-malformed-response-annotations");

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          response_annotations_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${messageId},
          ${ThreadId.make("thread-malformed-response-annotations")},
          NULL,
          'user',
          'Please explain.',
          '{',
          0,
          '2026-02-28T19:30:00.000Z',
          '2026-02-28T19:30:00.000Z'
        )
      `;

      const result = yield* Effect.result(repository.getByMessageId({ messageId }));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, PersistenceDecodeError);
        assert.include(result.failure.operation, "decodeRows");
      }
    }),
  );
});
