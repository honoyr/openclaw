import { buildCronExecOperationBinding } from "../gateway/operator-approval-standing-grants.js";
import {
  consumeCronStandingGrant,
  validateCronStandingGrant,
} from "../gateway/operator-approval-store.js";
import type { CronRunExecSource } from "../infra/cron-run-exec-source.js";
import { buildGatewayExecApprovalDeniedToolResult } from "./bash-tools.exec-approval-output.js";
import type {
  ProcessGatewayAllowlistParams,
  ProcessGatewayAllowlistResult,
} from "./bash-tools.exec-host-gateway.types.js";

export async function resolveCronStandingGrantExecution(
  params: ProcessGatewayAllowlistParams,
  cronExecutionSource: CronRunExecSource,
  assertGrantCurrent: () => void,
  emitGrantEvent: (approved: boolean, reason: string) => void,
): Promise<ProcessGatewayAllowlistResult | undefined> {
  const grantLookup = {
    agentId: cronExecutionSource.agentId,
    cronJobId: cronExecutionSource.jobId,
    jobConfigRevision: cronExecutionSource.jobConfigRevision,
    operationBinding: buildCronExecOperationBinding({
      command: params.command,
      cwd: params.workdir,
      env: params.requestedEnv,
    }),
  };
  let grantCheck: Awaited<ReturnType<typeof validateCronStandingGrant>> | undefined;
  try {
    grantCheck = await validateCronStandingGrant({
      ...grantLookup,
      assertCurrent: assertGrantCurrent,
    });
  } catch {
    grantCheck = undefined;
  }
  assertGrantCurrent();
  if (grantCheck?.outcome === "consumed") {
    return {
      assertCurrent: assertGrantCurrent,
      // Recheck durable rows after pre-spawn work; native launch retains the live source guard.
      revalidateBeforeExecution: async () => {
        let grantUse: Awaited<ReturnType<typeof consumeCronStandingGrant>> | undefined;
        try {
          grantUse = await consumeCronStandingGrant({
            ...grantLookup,
            assertCurrent: assertGrantCurrent,
          });
        } catch {
          grantUse = undefined;
        }
        assertGrantCurrent();
        if (grantUse?.outcome === "consumed") {
          emitGrantEvent(
            true,
            `standing-grant grant=${grantUse.grant.grantId} approval=${grantUse.grant.mintedByApprovalId}`,
          );
          return undefined;
        }
        const invalidReason = grantUse?.outcome ?? "grant-store-unavailable";
        emitGrantEvent(false, `standing-grant-invalidated ${invalidReason}`);
        return buildGatewayExecApprovalDeniedToolResult({
          deniedReason: `standing grant no longer valid (${invalidReason}); the next occurrence will prompt for approval again`,
          command: params.command,
          cwd: params.workdir,
        });
      },
    };
  }
  return undefined;
}
