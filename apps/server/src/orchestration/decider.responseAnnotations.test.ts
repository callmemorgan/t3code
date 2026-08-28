import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ResponseAnnotationId,
  ThreadId,
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
});
