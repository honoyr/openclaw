import type { WorktreeWorkerOperations } from "../agents/worktrees/dispatch.worker.js";
import type { FleetRegistryWriteOperations } from "../fleet/registry.types.js";
import type { ApnsRegistrationWorkerOperations } from "../infra/push-apns-store.worker-contract.js";
import type { WebPushWorkerOperations } from "../infra/push-web-store.worker-contract.js";
import type { UserProfileWorkerOperations } from "./user-profiles.worker.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

export type RegisteredStateWorkerOperations = WebPushWorkerOperations &
  ApnsRegistrationWorkerOperations &
  WorktreeWorkerOperations &
  FleetRegistryWriteOperations &
  UserProfileWorkerOperations;

export const stateWorkerRegistry = createWorkerOperationRegistry<RegisteredStateWorkerOperations>({
  userProfiles: () => import("./user-profiles.worker.js").then((m) => m.userProfileOperations),
  webPush: () => import("../infra/push-web-store.worker.js").then((m) => m.webPushOperations),
  apns: () => import("../infra/push-apns-store.worker.js").then((m) => m.apnsOperations),
  worktrees: () =>
    import("../agents/worktrees/dispatch.worker.js").then((m) => m.worktreeOperations),
  fleet: () => import("../fleet/registry.worker.js").then((m) => m.fleetOperations),
});
