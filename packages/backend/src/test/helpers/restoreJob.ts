// Restoring a backup runs as a job (services/backupRestoreJobs.ts): POST
// …/apply answers 202 with it, GET …/jobs/:id reports it. For tests that only
// care how the restore ended: start it, wait for the job, and answer as the
// synchronous route did — 200 with the report, or the failure's status with
// { error, job }. A refusal before the job starts (403, 404, 409) comes back
// as it was sent.

import type { Hono } from "hono";
import type { RestoreJob } from "@onden/contract";

export async function waitForJob(app: Pick<Hono, "request">, job: RestoreJob, timeoutMs = 120_000): Promise<RestoreJob> {
  const until = Date.now() + timeoutMs;
  while (job.status === "running") {
    if (Date.now() > until) throw new Error(`restore job ${job.id} still running (${job.phase} ${job.done}/${job.total})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const res = await app.request(`/api/backup/restore/jobs/${job.id}`);
    if (res.status !== 200) throw new Error(`job poll: ${res.status} ${await res.text()}`);
    job = ((await res.json()) as { job: RestoreJob }).job;
  }
  return job;
}

export async function applyAndWait(app: Pick<Hono, "request">, uploadId: string, space: string, mode: "empty" | "merge"): Promise<Response> {
  const started = await app.request(`/api/backup/restore/${uploadId}/apply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: space, mode }),
  });
  if (started.status !== 202 && started.status !== 200) return started;
  const job = await waitForJob(app, ((await started.json()) as { job: RestoreJob }).job);
  return job.status === "done"
    ? Response.json(job.result, { status: 200 })
    : Response.json({ error: job.error, job }, { status: job.error_status ?? 500 });
}
