import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../state/worker-operation-registry.js";
import {
  ensureProjectRegistrySchema,
  insertProjectRegistryInDatabase,
  listProjectRegistryInDatabase,
  removeProjectRegistryInDatabase,
  resolveProjectCloneRefreshOwnerInDatabase,
  resolveProjectRegistryInDatabase,
  resolveRecordedProjectRootInDatabase,
} from "./project-registry.kernel.js";
import type {
  ProjectCheckoutLeaseInput,
  ProjectRegistryIdentity,
  ProjectRegistryInsert,
} from "./project-registry.types.js";

function projectRegistryOptions({ open, stateOptions }: WorkerOperationContext) {
  const options = { database: open(), ...stateOptions() };
  ensureProjectRegistrySchema(options);
  return options;
}

export const projectRegistryOperations = {
  "projects.findRoot": (input: { repoRoot: string }, context) =>
    resolveRecordedProjectRootInDatabase(
      projectRegistryOptions(context).database.db,
      input.repoRoot,
    ),
  "projects.list": (_input: undefined, context) =>
    listProjectRegistryInDatabase(projectRegistryOptions(context).database.db),
  "projects.resolve": (input: { id: string }, context) =>
    resolveProjectRegistryInDatabase(projectRegistryOptions(context).database.db, input.id),
  "projects.insert": (input: ProjectCheckoutLeaseInput<ProjectRegistryInsert>, context) =>
    runCheckoutLeaseTransaction(
      input,
      projectRegistryOptions(context),
      "projects.registry.insert",
      (db) => insertProjectRegistryInDatabase(db, input.project),
    ),
  "projects.remove": (
    input: ProjectCheckoutLeaseInput<ProjectRegistryIdentity>,
    { open, stateOptions },
  ) =>
    runCheckoutLeaseTransaction(
      input,
      { database: open(), ...stateOptions() },
      "projects.registry.remove",
      (db) => removeProjectRegistryInDatabase(db, input.project),
    ),
  "projects.resolveRefreshOwner": (
    input: ProjectCheckoutLeaseInput<ProjectRegistryIdentity>,
    context,
  ) =>
    runCheckoutLeaseTransaction(
      input,
      projectRegistryOptions(context),
      "projects.registry.refresh-owner.resolve",
      (db) => resolveProjectCloneRefreshOwnerInDatabase(db, input.project),
    ),
} satisfies WorkerOperationHandlers;

// Registry writes are admitted only under the checkout lease for the same repo root.
function runCheckoutLeaseTransaction<T>(
  input: ProjectCheckoutLeaseInput<{ repoRoot: string }>,
  options: OpenClawStateDatabaseOptions,
  operationLabel: string,
  operation: (db: OpenClawStateDatabase["db"]) => T,
): T {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { project, lease } = input;
      if (lease.scope !== "projects.checkout" || lease.key !== project.repoRoot) {
        throw new Error("Project registry write requires its checkout lifecycle lease");
      }
      assertOpenClawStateLeaseWorkerOwnedInTransaction(db, lease);
      return operation(db);
    },
    options,
    { operationLabel },
  );
}
