import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_ProjectionThreadMessageResponseAnnotations", (it) => {
  it.effect("adds a nullable response annotations column to messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const annotations = columns.find((column) => column.name === "response_annotations_json");

      assert.equal(annotations?.name, "response_annotations_json");
      assert.equal(annotations?.notnull, 0);
    }),
  );
});
