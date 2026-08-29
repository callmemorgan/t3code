import {
  CommandId,
  MessageId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderInstanceId,
  ResponseAnnotationId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(messages: OrchestrationThread["messages"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages,
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const sourceMessage = {
  id: MessageId.make("assistant-source"),
  role: "assistant" as const,
  text: "The selected answer.",
  turnId: null,
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const annotation = {
  id: ResponseAnnotationId.make("annotation-1"),
  sourceMessageId: sourceMessage.id,
  selectedText: "selected answer",
  sourceRange: { start: 4, end: 19, prefix: "The ", suffix: "." },
  comment: "Explain this.",
};

function makeTurnStartCommand(input: {
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly responseAnnotations?: ReadonlyArray<typeof annotation>;
}) {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.make(input.commandId),
    threadId: ThreadId.make("thread-1"),
    message: {
      messageId: MessageId.make(input.messageId),
      role: "user" as const,
      text: input.text,
      attachments: [],
      ...(input.responseAnnotations !== undefined
        ? { responseAnnotations: input.responseAnnotations }
        : {}),
    },
    createdAt: NOW,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
}

it.layer(NodeServices.layer)("response annotation decider", (it) => {
  it.effect("copies valid annotations to the user message event", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-annotations-valid"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("user-1"),
            role: "user",
            text: "Please explain.",
            attachments: [],
            responseAnnotations: [annotation],
          },
          createdAt: NOW,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        readModel: makeReadModel([]),
        validationContext: {
          assistantMessageIds: new Set([sourceMessage.id]),
        },
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events[0]?.type).toBe("thread.message-sent");
      if (events[0]?.type === "thread.message-sent") {
        expect(events[0].payload.responseAnnotations).toEqual([annotation]);
      }
    }),
  );

  it.effect("uses explicit persisted ownership even when the command model has the message", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-annotations-not-owned"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("user-not-owned"),
            role: "user",
            text: "Please explain.",
            attachments: [],
            responseAnnotations: [annotation],
          },
          createdAt: NOW,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        readModel: makeReadModel([sourceMessage]),
        validationContext: {
          assistantMessageIds: new Set(),
        },
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects an annotation whose source message is outside the target thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-annotations-foreign"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("user-2"),
            role: "user",
            text: "Please explain.",
            attachments: [],
            responseAnnotations: [annotation],
          },
          createdAt: NOW,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        readModel: makeReadModel([]),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a source message that is still streaming", () =>
    Effect.gen(function* () {
      const streamingSource = { ...sourceMessage, streaming: true };
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-annotations-streaming"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("user-streaming-source"),
            role: "user",
            text: "Please explain.",
            attachments: [],
            responseAnnotations: [annotation],
          },
          createdAt: NOW,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        readModel: makeReadModel([streamingSource]),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects annotations when the command creates a new thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-annotations-bootstrap"),
          threadId: ThreadId.make("thread-new"),
          message: {
            messageId: MessageId.make("user-new"),
            role: "user",
            text: "Please explain.",
            attachments: [],
            responseAnnotations: [annotation],
          },
          bootstrap: {
            createThread: {
              projectId: ProjectId.make("project-1"),
              title: "New thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: NOW,
            },
          },
          createdAt: NOW,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        readModel: makeReadModel([]),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("accepts the aggregate provider-input limit at the boundary", () =>
    Effect.gen(function* () {
      const text = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
      const result = yield* decideOrchestrationCommand({
        command: makeTurnStartCommand({
          commandId: "cmd-annotations-at-limit",
          messageId: "user-at-limit",
          text,
        }),
        readModel: makeReadModel([]),
      });

      expect(Array.isArray(result)).toBe(true);
    }),
  );

  it.effect("rejects an oversized annotation envelope before emitting a message event", () =>
    Effect.gen(function* () {
      const oversizedAnnotations = Array.from({ length: 20 }, (_, index) => ({
        ...annotation,
        id: ResponseAnnotationId.make(`annotation-oversized-${index}`),
        selectedText: "x".repeat(8_000),
        sourceRange: { start: 0, end: 8_000, prefix: "", suffix: "" },
      }));
      const error = yield* decideOrchestrationCommand({
        command: makeTurnStartCommand({
          commandId: "cmd-annotations-over-limit",
          messageId: "user-over-limit",
          text: "",
          responseAnnotations: oversizedAnnotations,
        }),
        readModel: makeReadModel([]),
        validationContext: {
          assistantMessageIds: new Set([sourceMessage.id]),
        },
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("binds an annotated user message idempotently to the provider turn", () =>
    Effect.gen(function* () {
      const message = {
        id: MessageId.make("user-bind"),
        role: "user" as const,
        text: "Explain this",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
        responseAnnotations: [annotation],
      };
      const command = {
        type: "thread.response-annotations.bind-turn" as const,
        commandId: CommandId.make("cmd-bind-annotations"),
        threadId: ThreadId.make("thread-1"),
        messageId: message.id,
        turnId: TurnId.make("turn-bind"),
        createdAt: NOW,
      };
      const first = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel([message]),
      });
      expect(first).toMatchObject({
        type: "thread.message-sent",
        payload: {
          messageId: message.id,
          role: "user",
          text: message.text,
          responseAnnotations: message.responseAnnotations,
          turnId: command.turnId,
          streaming: false,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        },
      });

      const reboundMessage = { ...message, turnId: command.turnId };
      const second = yield* decideOrchestrationCommand({
        command: { ...command, commandId: CommandId.make("cmd-bind-annotations-retry") },
        readModel: makeReadModel([reboundMessage]),
      });
      expect(second).toMatchObject({
        type: "thread.message-sent",
        payload: {
          messageId: message.id,
          responseAnnotations: message.responseAnnotations,
          turnId: command.turnId,
        },
      });
    }),
  );
});
