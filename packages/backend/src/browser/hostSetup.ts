// What the backend needs installed before it is first used on a host that is not Node
// (docs/architecture/portable-backend.md §5). Imported right after env.ts, before the app.

import { createSerialContextProvider, useContextProvider } from "../requestContext.js";
import { useMigrationSource } from "../dbMigrations.js";
import { useJobRunner } from "../backgroundJobs.js";
import migrationFiles from "virtual:migrations";
import { createSerialQueue } from "./queue.js";

useContextProvider(createSerialContextProvider());
useMigrationSource(async () => migrationFiles.map(([version, sql]) => ({ version, sql })));

/** Requests, periodic jobs and saving a copy all run through this one queue. */
export const workerQueue = createSerialQueue();
useJobRunner((job) => workerQueue.run(job));
