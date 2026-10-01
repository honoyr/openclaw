import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { buildCronExecOperationBinding } from "../gateway/operator-approval-standing-grants.js";
import * as approvalStore from "../gateway/operator-approval-store.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../gateway/operator-approval-store.js";
import { registerCronRunExecSource } from "../infra/cron-run-exec-source.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  hasDurableExecApprovalMock,
  requiresExecApprovalMock,
  commitExecAuthorizationMock,
  approvalDecisionMock,
  createExecApprovalRequestRouteMock,
  captureSecurityEvents,
  mockHostPolicy,
  runGatewayAllowlist,
  installGatewayAllowlistFixture,
} from "./bash-tools.exec-host-gateway.test-support.js";

describe("processGatewayAllowlist cron standing grants", () => {
  installGatewayAllowlistFixture();
  const CRON_STORE_KEY = "/tmp/openclaw-exec-host-cron-store";
  const grantCommand = "run-nightly-backup --verbose";
  let workdir: string;
  let unregisterCronSource: (() => void) | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      unregisterCronSource?.();
      unregisterCronSource = undefined;
      await closeOpenClawStateDatabaseAsync();
      vi.unstubAllEnvs();
      cleanup();
    }),
  );

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-grant-state-"));
    workdir = tempDirs.make("openclaw-cron-grant-cwd-");
    // Grants are consulted only when policy would otherwise prompt, before
    // any JSON allowlist digest can satisfy the command.
    requiresExecApprovalMock.mockReturnValue(true);
    hasDurableExecApprovalMock.mockReturnValue(false);
    mockHostPolicy({ hostAsk: "on-miss" });
  });

  function databaseOptions() {
    return { env: { ...process.env } };
  }

  function seedCronJobRow(): string {
    const database = openOpenClawStateDatabase(databaseOptions());
    // SAFETY: minimal valid cron job shape for the storage codec round-trip.
    const job = {
      id: "job-1",
      agentId: "main",
      name: "Nightly backup",
      enabled: true,
      createdAtMs: Date.now() - 1_000,
      updatedAtMs: Date.now() - 1_000,
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run the backup" },
    } as CronStoredJob;
    upsertCronJobRow(database.db, CRON_STORE_KEY, job, 0);
    const loaded = loadedCronStoreFromRows(loadCronRows(database.db, CRON_STORE_KEY));
    const loadedJob = loaded.store.jobs.find((entry) => entry.id === "job-1");
    if (!loadedJob) {
      throw new Error("seeded cron job did not load back");
    }
    return resolveCronJobConfigRevision(loadedJob);
  }

  async function mintStandingGrant(revision: string): Promise<void> {
    await insertOperatorApproval({
      approval: {
        id: "cron-approval-1",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: grantCommand,
          commandPreview: grantCommand,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
        reviewerDeviceIds: [],
        source: {
          agentId: "main",
          sessionKey: "agent:main:cron:job-1",
          sessionId: "session-1",
          runId: "cron-run-0",
          toolCallId: null,
          toolName: "exec",
        },
        audienceSessionKeys: [],
        runtimeEpoch: "epoch-1",
        createdAtMs: Date.now() - 500,
        expiresAtMs: Date.now() + 60_000,
      },
      databaseOptions: databaseOptions(),
    });
    const resolved = await resolveOperatorApproval({
      id: "cron-approval-1",
      decision: "allow-always",
      resolver: { kind: "device", id: "reviewer-1" },
      databaseOptions: databaseOptions(),
      standingGrant: {
        kind: "cron",
        agentId: "main",
        cronJobId: "job-1",
        jobConfigRevision: revision,
        operationBinding: buildCronExecOperationBinding({
          command: grantCommand,
          cwd: workdir,
          env: undefined,
        }),
        expiresAtMs: null,
      },
    });
    expect(resolved.outcome).toBe("resolved");
  }

  function readGrantUseCounts(): number[] {
    const database = openOpenClawStateDatabase(databaseOptions());
    const stateDb = getNodeSqliteKysely<
      Pick<OpenClawStateKyselyDatabase, "operator_approval_standing_grants">
    >(database.db);
    return executeSqliteQuerySync(
      database.db,
      stateDb.selectFrom("operator_approval_standing_grants").select(["use_count"]),
    ).rows.map((row) => row.use_count);
  }

  async function prepareCronRun(mintGrant: boolean) {
    const revision = seedCronJobRow();
    if (mintGrant) {
      await mintStandingGrant(revision);
    }
    unregisterCronSource = registerCronRunExecSource("cron-run-1", {
      agentId: "main",
      jobId: "job-1",
      jobConfigRevision: revision,
      jobName: "Nightly backup",
    });
  }

  function runCron() {
    return runGatewayAllowlist({
      command: grantCommand,
      workdir,
      agentId: "main",
      runId: "cron-run-1",
      ask: "on-miss",
    });
  }

  it("executes a cron occurrence via a standing grant without prompting", async () => {
    await prepareCronRun(true);
    const security = captureSecurityEvents();
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      const result = await runCron();
      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
      sql.expectIdle();
      expect(readGrantUseCounts()).toEqual([0]);
      sql.clear();
      expect(result.revalidateBeforeExecution).toBeDefined();
      await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
      sql.expectIdle();
    } finally {
      sql.restore();
      security.stop();
    }
    expect(JSON.stringify(security.events)).toContain("standing-grant");
    expect(readGrantUseCounts()).toEqual([1]);
  });

  it.each(["validateCronStandingGrant", "consumeCronStandingGrant"] as const)(
    "rejects a retired cron source while %s returns",
    async (operation) => {
      await prepareCronRun(true);
      const approved = operation === "consumeCronStandingGrant" ? await runCron() : undefined;
      const settled = createDeferredCore();
      const release = createDeferredCore();
      const execute = approvalStore[operation];
      using delayed = vi.spyOn(approvalStore, operation);
      delayed.mockImplementationOnce(async (params) => {
        const result = await execute(params);
        settled.resolve();
        await release.promise;
        return result;
      });
      const pending = approved ? approved.revalidateBeforeExecution!() : runCron();
      await settled.promise;
      unregisterCronSource?.();
      release.resolve();
      await expect(pending).rejects.toThrow("Cron execution source is no longer active");
      expect(createExecApprovalRequestRouteMock).not.toHaveBeenCalled();
      if (approved) {
        expect(() => approved.assertCurrent?.()).toThrow(
          "Cron execution source is no longer active",
        );
      }
    },
  );

  it("denies execution when the worker rejects final grant consumption", async () => {
    await prepareCronRun(true);
    const approved = await runCron();
    using consume = vi.spyOn(approvalStore, "consumeCronStandingGrant");
    consume.mockRejectedValueOnce(new Error("synthetic worker unavailable"));
    const denied = await approved.revalidateBeforeExecution?.();
    expect(denied?.details.status).toBe("failed");
    expect(denied?.content[0]).toMatchObject({
      text: expect.stringContaining("grant-store-unavailable"),
    });
    expect(readGrantUseCounts()).toEqual([0]);
  });

  it("denies at the spawn boundary when the grant is invalidated after consult", async () => {
    await prepareCronRun(true);
    const security = captureSecurityEvents();
    const result = await runCron();
    expect(result.pendingResult).toBeUndefined();
    expect(result.deniedResult).toBeUndefined();
    expect(result.revalidateBeforeExecution).toBeDefined();
    // Revoke the parent approval between consult and spawn: the closure
    // must deny instead of executing on the stale authority.
    const database = openOpenClawStateDatabase(databaseOptions());
    // sqlite-allow-raw -- test-only reversal of the minting approval row.
    database.db.prepare("update operator_approvals set status = 'denied', decision = 'deny'").run();
    const denied = await result.revalidateBeforeExecution?.();
    security.stop();
    expect(denied?.details.status).toBe("failed");
    expect(denied?.content[0]).toMatchObject({
      text: expect.stringContaining("standing grant no longer valid"),
    });
    expect(readGrantUseCounts()).toEqual([0]);
    expect(JSON.stringify(security.events)).toContain("standing-grant-invalidated");
  });

  it("skips the JSON allowlist digest when a cron allow-always resolves", async () => {
    await prepareCronRun(false);
    const committed = createDeferredCore();
    commitExecAuthorizationMock.mockImplementationOnce(async () => {
      committed.resolve();
      return () => {};
    });
    approvalDecisionMock.mockResolvedValue("allow-always");
    const result = await runCron();
    expect(result.pendingResult).toBeUndefined();
    expect(result.deniedResult).toBeUndefined();
    await committed.promise;
    expect(commitExecAuthorizationMock).toHaveBeenCalledOnce();
    expect(commitExecAuthorizationMock.mock.calls[0]?.[0].allowAlwaysDecision).toBeUndefined();
  });
});
