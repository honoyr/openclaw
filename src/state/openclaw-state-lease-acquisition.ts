import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import {
  isSqliteLockError,
  isSqliteNativeOpenFailure,
  sqliteExtendedResultCode,
} from "../infra/sqlite-error-diagnostics.js";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import type {
  OpenClawStateLeaseAcquisition,
  OpenClawStateLeaseIdentity,
} from "./openclaw-state-lease-context.js";
import {
  OpenClawStateLeaseAcquisitionError,
  OpenClawStateLeaseError,
} from "./openclaw-state-lease-error.js";
import {
  resolveLeaseDatabasePath,
  STATE_LEASE_WRITE_BACKOFF,
  type OpenClawStateLeaseDatabase,
} from "./openclaw-state-lease-storage.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

const log = createSubsystemLogger("state/lease");

/** Wait for recorded holders; each storage owner admits and settles its own write. */
export async function acquireOpenClawStateLease(params: {
  label: string;
  waitMs: number;
  signal?: AbortSignal;
  assertCurrent(): void;
  prepare?(this: void): void;
  acquire(assertCurrent: () => void, signal?: AbortSignal): Promise<OpenClawStateLeaseAcquisition>;
  acquired(expiresAt: number): void;
}): Promise<void> {
  const startedAt = performance.now();
  let deadline = startedAt + params.waitMs;
  let preparation = params.prepare;
  let attempt = 0;
  let lastReportedHolder: string | undefined;
  const cancellation = params.signal ? new AbortController() : undefined;
  let aborted: OpenClawStateLeaseAcquisitionError | undefined;
  const abort = () => {
    aborted ??= new OpenClawStateLeaseAcquisitionError(
      params.label,
      {
        kind: "aborted",
        reason: "caller-signal",
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      },
      params.signal?.reason,
    );
    cancellation?.abort(aborted);
    return aborted;
  };
  const assertCurrent = () => {
    params.assertCurrent();
    if (params.signal?.aborted) {
      throw abort();
    }
  };
  params.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      assertCurrent();
      let outcome: OpenClawStateLeaseAcquisition;
      try {
        if (preparation) {
          const prepare = preparation;
          preparation = undefined;
          prepare();
          deadline = performance.now() + params.waitMs;
        }
        outcome = await params.acquire(assertCurrent, cancellation?.signal);
      } catch (error) {
        if (
          !(
            error instanceof OpenClawStateLeaseError &&
            error.code === "OPENCLAW_STATE_LEASE_STORAGE_FAILED"
          ) &&
          !isSqliteLockError(error) &&
          !isSqliteNativeOpenFailure(error) &&
          sqliteExtendedResultCode(error) === undefined &&
          !isSqliteWorkerError(error, "unavailable") &&
          !isSqliteWorkerError(error, "overloaded") &&
          !isSqliteWorkerError(error, "closed")
        ) {
          throw error;
        }
        const failure = error instanceof OpenClawStateLeaseError ? error.cause : error;
        if (isSqliteLockError(failure)) {
          assertCurrent();
        }
        throw new OpenClawStateLeaseAcquisitionError(
          params.label,
          {
            kind: "store-unavailable",
            reason: isSqliteLockError(failure) ? "sqlite-busy" : "storage-error",
          },
          error,
        );
      }
      if (outcome.kind === "acquired") {
        // Publish cleanup custody before cancellation can reject callback entry.
        params.acquired(outcome.expiresAt);
        assertCurrent();
        return;
      }
      assertCurrent();
      const now = performance.now();
      if (now >= deadline) {
        throw new OpenClawStateLeaseAcquisitionError(params.label, outcome);
      }
      const holderIdentity = `${outcome.holder.owner}:${outcome.holder.epoch}`;
      if (lastReportedHolder !== holderIdentity) {
        lastReportedHolder = holderIdentity;
        const expiry =
          outcome.holder.expiresAt === null
            ? "has no recorded expiry"
            : `expires at ${new Date(outcome.holder.expiresAt).toISOString()}`;
        log.warn(
          `Waiting for ${params.label} held by ${outcome.holder.owner}; current lease ${expiry}.`,
        );
      }
      attempt += 1;
      try {
        await sleepWithAbort(
          Math.min(deadline - now, computeBackoff(STATE_LEASE_WRITE_BACKOFF, attempt)),
          params.signal,
        );
      } catch (error) {
        assertCurrent();
        throw error;
      }
    }
  } finally {
    params.signal?.removeEventListener("abort", abort);
  }
}

export async function acquireLease(
  database: OpenClawStateLeaseDatabase,
  input: {
    identity: OpenClawStateLeaseIdentity;
    leaseMs: number;
    operationLabel: string;
    processBound?: boolean;
  },
  assertCurrent: () => void,
  signal?: AbortSignal,
) {
  if (database.options?.readOnly) {
    throw new Error("State lease acquisition requires writable storage");
  }
  if (database.schemaPolicy === "existing" && database.options?.database) {
    throw new Error("Existing-state writes require their own tracked writable connection.");
  }
  const opened =
    database.schemaPolicy === "existing" ? undefined : openOpenClawStateDatabase(database.options);
  const context = captureOpenClawStateWorkerContext({
    ...database.options,
    path: opened?.path ?? resolveLeaseDatabasePath(database),
  });
  const assertAdmission = () => {
    context.admission.assertCurrent();
    assertCurrent();
    // The worker cannot join a transaction held by the caller's verification handle.
    if (opened?.db.isTransaction) {
      throw new OpenClawStateLeaseError("State lease acquisition requires no active transaction", {
        code: "OPENCLAW_STATE_LEASE_INVALID_INPUT",
      });
    }
  };
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute(
        {
          type: "stateLease.acquire",
          input: { ...input, schemaPolicy: database.schemaPolicy },
        },
        { signal },
      ),
    {
      existingOnly: database.schemaPolicy === "existing",
      assertCurrent: assertAdmission,
      createAdmission: createSqliteWorkerWriteAdmission(assertAdmission, [
        context.admission.databasePath,
      ]),
    },
  );
  if (!result) {
    throw new Error("State lease acquisition requires an existing database");
  }
  return result;
}
