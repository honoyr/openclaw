import crypto from "node:crypto";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../infra/diagnostic-events.js";
import type {
  ExecAllowlistEntry,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecAsk,
  ExecCommandSegment,
  ExecSecurity,
  ExecSegmentSatisfiedBy,
} from "../infra/exec-approvals.js";
import type { ExecAuthorizationPlan } from "../infra/exec-authorization-plan.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";

type SendExecApprovalFollowupResult =
  typeof import("./bash-tools.exec-host-shared.js").sendExecApprovalFollowupResult;
export type ExecAutoReviewer =
  typeof import("../infra/exec-auto-review.js").defaultExecAutoReviewer;
type MockAllowlistSegment = Omit<ExecCommandSegment, "raw"> & { raw?: string };
type MockAllowlistResult = {
  allowlistMatches: unknown[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  segments: MockAllowlistSegment[];
  segmentAllowlistEntries: unknown[];
  segmentSatisfiedBy?: ExecSegmentSatisfiedBy[];
  authorizationPlan?: ExecAuthorizationPlan;
};
type MockExecHostApprovalContext = {
  approvals: {
    allowlist: ExecAllowlistEntry[];
    file: ExecApprovalsFile;
    agent?: Required<ExecApprovalsDefaults>;
  };
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback?: ExecSecurity;
};

export const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

export function exactCommandMarker(command: string): string {
  return `=command:${crypto.createHash("sha256").update(command.trim()).digest("hex").slice(0, 16)}`;
}

const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const buildExecApprovalFollowupTargetMock = vi.hoisted(() =>
  vi.fn<typeof import("./bash-tools.exec-host-shared.js").buildExecApprovalFollowupTarget>(),
);
const evaluateShellAllowlistWithAuthorizationMock = vi.hoisted(() =>
  vi.fn<() => MockAllowlistResult>(),
);
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const hasExactCommandDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const requiresExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const buildEnforcedShellCommandMock = vi.hoisted(() =>
  vi.fn<() => { ok: boolean; reason?: string; command?: string }>(),
);
const defaultExecAutoReviewerMock = vi.hoisted(() => vi.fn<ExecAutoReviewer>());
const commitExecAuthorizationMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/exec-approvals.js").commitExecAuthorizationLocked>(
    async () => () => {},
  ),
);
const approvalDecisionMock = vi.hoisted(() =>
  vi.fn<() => Promise<string | null | undefined>>(async () => undefined),
);
const runAbortedApprovalError = vi.hoisted(() => new Error("run aborted"));
const approvalRouteFixture = vi.hoisted(() => ({ inline: false, id: "" }));
const callGatewayToolMock = vi.hoisted(() =>
  vi.fn(async (method: string, _options: unknown, params: { id: string }) => {
    if (method === "exec.approval.request") {
      approvalRouteFixture.id = params.id;
      return approvalRouteFixture.inline ? { decision: null } : { status: "accepted" };
    }
    if (method !== "exec.approval.waitDecision") {
      throw new Error(`Unexpected gateway method: ${method}`);
    }
    try {
      const decision = await approvalDecisionMock();
      if (decision === undefined) {
        throw new Error("approval request failed");
      }
      return { decision };
    } catch (error) {
      if (error === runAbortedApprovalError) {
        return { terminalReason: "run-aborted" };
      }
      throw error;
    }
  }),
);
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn<() => MockExecHostApprovalContext>(),
);
const runExecProcessMock = vi.hoisted(() => vi.fn());
const startupCancellationMocks = vi.hoisted(() => ({
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  prepare: vi.fn<() => void>(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: startupCancellationMocks.spawn }),
}));

vi.mock("./shell-snapshot.js", () => ({
  maybeWrapCommandWithShellSnapshot: async (input: { command: string }) => {
    startupCancellationMocks.prepare();
    return input.command;
  },
}));

const markBackgroundedMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() =>
  vi.fn<SendExecApprovalFollowupResult>(async () => undefined),
);
const createExecApprovalRequestRouteMock = vi.hoisted(() =>
  vi.fn<typeof import("./bash-tools.exec-host-shared.js").createExecApprovalRequestRoute>(),
);
const detectInterpreterInlineEvalArgvMock = vi.hoisted(() =>
  vi.fn<() => typeof INLINE_EVAL_HIT | null>(),
);

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  evaluateShellAllowlistWithAuthorization: evaluateShellAllowlistWithAuthorizationMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  hasExactCommandDurableExecApproval: hasExactCommandDurableExecApprovalMock,
  buildEnforcedShellCommand: buildEnforcedShellCommandMock,
  requiresExecApproval: requiresExecApprovalMock,
  commitExecAuthorizationLocked: commitExecAuthorizationMock,
  resolveApprovalAuditTrustPath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
}));

vi.mock("../infra/exec-auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-auto-review.js")>()),
  defaultExecAutoReviewer: defaultExecAutoReviewerMock,
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bash-tools.exec-host-shared.js")>();
  createExecApprovalRequestRouteMock.mockImplementation(actual.createExecApprovalRequestRoute);
  buildExecApprovalFollowupTargetMock.mockImplementation(actual.buildExecApprovalFollowupTarget);
  return {
    ...actual,
    resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
    buildExecApprovalFollowupTarget: buildExecApprovalFollowupTargetMock,
    buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
    createExecApprovalRequestRoute: createExecApprovalRequestRouteMock,
    sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  };
});

vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-runtime.js")>()),
  runExecProcess: runExecProcessMock,
}));

vi.mock("./bash-process-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-process-registry.js")>()),
  getActiveBackgroundExecSessionCount: vi.fn(() => 0),
  markBackgrounded: markBackgroundedMock,
  tail: vi.fn((value) => value),
}));

vi.mock("../infra/command-analysis/inline-eval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/command-analysis/inline-eval.js")>()),
  describeInterpreterInlineEval: vi.fn(() => "python -c"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;
type GatewayAllowlistParams = Parameters<typeof processGatewayAllowlist>[0];

export function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

export function mockHostPolicy(overrides: Partial<MockExecHostApprovalContext> = {}) {
  resolveExecHostApprovalContextMock.mockReturnValue({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "allowlist",
    hostAsk: "off",
    askFallback: "deny",
    ...overrides,
  });
}

export function mockAllowlist(overrides: Partial<MockAllowlistResult> = {}) {
  evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: false,
    segments: [],
    segmentAllowlistEntries: [],
    ...overrides,
  });
}

export function runGatewayAllowlist(
  overrides: Partial<GatewayAllowlistParams> & Pick<GatewayAllowlistParams, "command">,
) {
  const { command, ...rest } = overrides;
  return processGatewayAllowlist({
    command,
    workdir: process.cwd(),
    env: process.env as Record<string, string>,
    pty: false,
    defaultTimeoutSec: 30,
    security: "allowlist",
    ask: "off",
    safeBins: new Set(),
    safeBinProfiles: {},
    warnings: [],
    approvalRunningNoticeMs: 0,
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    ...rest,
  });
}

export function installGatewayAllowlistFixture() {
  beforeAll(async () => {
    ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetDiagnosticEventsForTest();
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockClear();
    evaluateShellAllowlistWithAuthorizationMock.mockReset();
    mockAllowlist({
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["echo", "ok"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      segmentSatisfiedBy: [],
    });
    hasDurableExecApprovalMock.mockReset();
    hasDurableExecApprovalMock.mockReturnValue(true);
    hasExactCommandDurableExecApprovalMock.mockReset();
    hasExactCommandDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReset();
    requiresExecApprovalMock.mockReturnValue(false);
    buildEnforcedShellCommandMock.mockReset();
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: false,
      reason: "segment execution plan unavailable",
    });
    defaultExecAutoReviewerMock.mockReset();
    defaultExecAutoReviewerMock.mockResolvedValue({
      decision: "allow-once",
      risk: "low",
      rationale: "allowed",
    });
    commitExecAuthorizationMock.mockReset();
    approvalDecisionMock.mockReset();
    approvalDecisionMock.mockResolvedValue(undefined);
    approvalRouteFixture.inline = false;
    callGatewayToolMock.mockClear();
    approvalRouteFixture.id = "";
    resolveExecHostApprovalContextMock.mockReset();
    mockHostPolicy();
    runExecProcessMock.mockReset();
    startupCancellationMocks.spawn.mockReset();
    startupCancellationMocks.prepare.mockReset();
    markBackgroundedMock.mockReset();
    sendExecApprovalFollowupResultMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      details: { status: "approval-pending" },
      content: [],
    });
    createExecApprovalRequestRouteMock.mockClear();
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    resetGatewayWorkAdmission();
  });
}

export {
  buildExecApprovalPendingToolResultMock,
  buildExecApprovalFollowupTargetMock,
  hasDurableExecApprovalMock,
  hasExactCommandDurableExecApprovalMock,
  requiresExecApprovalMock,
  buildEnforcedShellCommandMock,
  defaultExecAutoReviewerMock,
  commitExecAuthorizationMock,
  approvalDecisionMock,
  runAbortedApprovalError,
  approvalRouteFixture,
  runExecProcessMock,
  startupCancellationMocks,
  markBackgroundedMock,
  sendExecApprovalFollowupResultMock,
  createExecApprovalRequestRouteMock,
  detectInterpreterInlineEvalArgvMock,
};
