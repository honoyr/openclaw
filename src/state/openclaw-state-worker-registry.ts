import type { WorktreeWorkerOperations } from "../agents/worktrees/dispatch.worker.js";
import type { FleetRegistryWriteOperations } from "../fleet/registry.worker-contract.js";
import type { WorkerInferenceStoreOperations } from "../gateway/worker-environments/inference-store.worker-contract.js";
import type { WorkerPlacementDispatchStoreOperations } from "../gateway/worker-environments/placement-dispatch-store.worker-contract.js";
import type { PlacementSessionToolWorkerOperations } from "../gateway/worker-environments/placement-session-tool-operations.worker-contract.js";
import type { PlacementTurnClaimWorkerOperations } from "../gateway/worker-environments/placement-turn-claims.worker-contract.js";
import type { WorkspaceJournalWorkerOperations } from "../gateway/worker-environments/placement-workspace-journal.worker-contract.js";
import type { WorkerEnvironmentWorkerOperations } from "../gateway/worker-environments/store-worker-contract.js";
import type { ApnsRegistrationWorkerOperations } from "../infra/push-apns-store.worker-contract.js";
import type { WebPushWorkerOperations } from "../infra/push-web-store.worker-contract.js";
import type { ProjectRegistryWorkerOperations } from "../projects/project-registry.worker-contract.js";
import type { RepositoryWorkspaceWorkerOperations } from "./session-repository-workspaces.worker-contract.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

export type RegisteredStateWorkerOperations = WebPushWorkerOperations &
  ApnsRegistrationWorkerOperations &
  WorktreeWorkerOperations &
  FleetRegistryWriteOperations &
  WorkerInferenceStoreOperations &
  WorkerPlacementDispatchStoreOperations &
  PlacementSessionToolWorkerOperations &
  PlacementTurnClaimWorkerOperations &
  WorkspaceJournalWorkerOperations &
  WorkerEnvironmentWorkerOperations &
  ProjectRegistryWorkerOperations &
  RepositoryWorkspaceWorkerOperations;

export const stateWorkerRegistry = createWorkerOperationRegistry<RegisteredStateWorkerOperations>({
  webPush: () => import("../infra/push-web-store.worker.js").then((m) => m.webPushOperations),
  apns: () => import("../infra/push-apns-store.worker.js").then((m) => m.apnsOperations),
  worktrees: () =>
    import("../agents/worktrees/dispatch.worker.js").then((m) => m.worktreeOperations),
  fleet: () => import("../fleet/registry.worker.js").then((m) => m.fleetOperations),
  workerInference: () =>
    import("../gateway/worker-environments/inference-store.worker.js").then(
      (m) => m.workerInferenceOperations,
    ),
  workerPlacements: () =>
    import("../gateway/worker-environments/placement-dispatch-store.worker.js").then(
      (m) => m.workerPlacementOperations,
    ),
  placementTools: () =>
    import("../gateway/worker-environments/placement-session-tool-operations.worker.js").then(
      (m) => m.placementSessionToolOperations,
    ),
  placementTurns: () =>
    import("../gateway/worker-environments/placement-turn-claims.worker.js").then(
      (m) => m.placementTurnClaimOperations,
    ),
  placementJournals: () =>
    import("../gateway/worker-environments/placement-workspace-journal.worker.js").then(
      (m) => m.workspaceJournalOperations,
    ),
  workerEnvironments: () =>
    import("../gateway/worker-environments/store.worker.js").then(
      (m) => m.workerEnvironmentOperations,
    ),
  projects: () =>
    import("../projects/project-registry.worker.js").then((m) => m.projectRegistryOperations),
  repositoryWorkspaces: () =>
    import("./session-repository-workspaces.worker.js").then(
      (m) => m.repositoryWorkspaceOperations,
    ),
});
