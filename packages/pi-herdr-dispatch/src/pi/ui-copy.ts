import type {
  AttentionCondition,
  DispatchLifecycle,
  DispatchMode,
  FinalOutcome,
  TaskParkedReason,
  TaskState,
} from "../registry/types.js";
import type { TaskWorktreeRefusalReason } from "../domain/task-worktree-path.js";

export type HumanDispatchAction = "reply" | "cancel" | "resolve";
export type HumanCommand =
  | "agents"
  | "new"
  | "create"
  | "clean"
  | "manager"
  | "auto"
  | "task"
  | "reply"
  | "cancel"
  | "resolve"
  | "setup"
  | "output";
export type TechnicalLabel = "dispatch" | "terminal" | "origin" | "workspace" | "worktree";

export interface HumanUiCopy {
  readonly state: {
    outcome(outcome: FinalOutcome | string): string;
    lifecycle(lifecycle: DispatchLifecycle | string): string;
    agentStatus(status: string): string;
    attention(condition: AttentionCondition): string;
    mode(mode: DispatchMode): string;
    provenance(reported: boolean): string;
    task(state: TaskState): string;
    role(role: string): string;
    parkedReason(reason: TaskParkedReason): string;
    workflowStage(stage: number, total: number): string;
  };
  readonly time: {
    relativeDeadline(deadlineAt: number, now: number): string;
    relativeAge(timestamp: number, now: number): string;
  };
  readonly count: {
    eligibleAgents(count: number): string;
    unsettledDispatches(count: number): string;
    lines(count: number): string;
    earlierLines(count: number): string;
    moreConditions(count: number): string;
    files(count: number): string;
    tests(count: number): string;
    delivering(count: number): string;
    running(count: number): string;
    attention(count: number): string;
  };
  readonly common: {
    untitledDispatch(): string;
    untitledTask(): string;
    dispatchFallback(): string;
    deadline(value: string): string;
    worktree(value: string): string;
    dispatch(value: string): string;
    terminal(value: string): string;
  };
  readonly command: {
    description(command: HumanCommand): string;
    dispatchTuiOnly(): string;
    createTuiOnly(): string;
    cleanTuiOnly(): string;
    proposalTuiOnly(): string;
    managerTuiOnly(): string;
    setupTuiOnly(): string;
    followupTuiOnly(): string;
    noEligibleAgents(): string;
    chooseEligibleAgent(): string;
    noLaunchableAgents(): string;
    integrationStatusFailed(reason: string): string;
    chooseAgentType(): string;
    chooseAgentLayout(): string;
    agentLayout(layout: "adaptive" | "right" | "down" | "new-tab"): string;
    creatingAgent(agent: string): string;
    agentCreationCancelled(location?: string): string;
    agentCreationFailed(reason: string, location?: string): string;
    agentCreationPreflightFailed(reason: string): string;
    createdResourceLocation(paneId?: string, tabId?: string, worktreePath?: string): string | undefined;
    taskWorktreePlacement(): string;
    newTaskWorktreePlacement(): string;
    currentDirectoryPlacement(): string;
    taskWorktreeCreationFailed(reason: string): string;
    sharedWorktreeHint(): string;
    noTaskWorktrees(): string;
    chooseTaskWorktreeCleanup(): string;
    cleanAllTaskWorktrees(count: number): string;
    taskWorktreeCleanupEntry(path: string, branch: string, reasons: readonly string[]): string;
    taskWorktreeRefusalReason(reason: TaskWorktreeRefusalReason): string;
    taskWorktreeCleanupConfirm(count: number): string;
    taskWorktreeCleanupConfirmBody(paths: readonly string[]): string;
    taskWorktreeCleanupComplete(count: number): string;
    taskWorktreeCleanupFailed(path: string, reason: string): string;
    selectedAgentUnavailable(): string;
    completeTask(): string;
    mutationMode(): string;
    deadlineMinutes(defaultMinutes: number): string;
    dependencyInstallTitle(): string;
    dependencyInstallQuestion(): string;
    selectedDispatchUnavailable(): string;
    runtimeUnavailable(): string;
    followupRuntimeUnavailable(): string;
    invalidDispatchSelector(): string;
    dispatchNotFound(selector: string): string;
    chooseMatchingDispatch(): string;
    noDispatchForAction(action: HumanDispatchAction): string;
    alreadySettled(outcome?: string): string;
    originOnlyFollowup(): string;
    lostOrMovedResolutionOnly(): string;
    replyRequiresActive(): string;
    replyRequiresAttention(): string;
    setupNoStatusOutput(): string;
    setupChooseIntegration(): string;
    setupCancel(): string;
    setupConfirmTitle(integration: string): string;
    setupConfirmBody(): string;
    setupInstallFailed(code: number): string;
    setupInstalled(integration: string): string;
    outputUsage(): string;
    followupTask(): string;
    redispatchTargetBusy(): string;
    redispatchTargetGone(): string;
    autoUsage(): string;
    autoTuiOnly(): string;
    autoStatus(armed: boolean, maxDepth: number, remainingQuota?: number): string;
    autoEnabled(maxDepth: number, remainingQuota?: number): string;
    autoDisabled(): string;
    taskTuiOnly(): string;
    taskAction(): string;
    taskManualEntry(): string;
    taskOpenBoard(): string;
    taskTitle(): string;
    taskText(): string;
    taskPreferredWorktree(): string;
    taskNoPreferredWorktree(): string;
    taskRole(): string;
    taskNoRole(): string;
    taskWorkflow(): string;
    taskAutomaticWorkflow(workflow?: string): string;
    taskWorkflowOption(workflow: string): string;
    taskDraftCreated(): string;
    tasksApproved(count: number): string;
    tasksAccepted(count: number): string;
    taskDraftDeleted(): string;
    taskDeleteConfirm(title: string): string;
    taskDeleteConfirmBody(): string;
    taskDemoteConfirm(title: string): string;
    taskDemoteConfirmBody(): string;
    taskDemoted(): string;
    selectedTaskUnavailable(): string;
    taskReturnFeedback(): string;
    taskReturned(): string;
    runQuotaExhausted(): string;
    taskDraftInvalid(): string;
    taskOperationFailed(): string;
  };
  readonly manager: {
    title(): string;
    detailTitle(): string;
    heading(
      running: number,
      delivering: number,
      attention: number,
      autoRunArmed?: boolean,
      draftTasks?: number,
      reviewTasks?: number,
      remainingQuota?: number,
    ): string;
    groupAttention(): string;
    groupRunning(): string;
    groupDelivering(): string;
    groupUnseenSettled(): string;
    taskBoardHeading(): string;
    taskGroup(state: TaskState): string;
    settledHeading(count: number, shown: boolean): string;
    listKeybar(settledShown: boolean, hasUnseen: boolean, hasTasks?: boolean): string;
    emergencyResolutionRequired(): string;
    activeSince(age: string): string;
    deliveryStarted(age: string): string;
    targetMayHaveReceivedInput(): string;
    reservationsRetained(): string;
    outputNoneRead(): string;
    outputReadInstructions(): string;
    outputReading(lines: number): string;
    outputReadFailed(): string;
    outputEarlierLinesNotShown(count: number): string;
    outputReadEnd(time: string): string;
    detailKeybar(actions: readonly HumanDispatchAction[], redispatch?: boolean): string;
    technicalHeading(): string;
    technicalLabel(label: TechnicalLabel): string;
    viewUnavailable(reason: string): string;
    closeKeybar(): string;
    missingRegistryDispatch(): string;
    backKeybar(): string;
  };
  readonly presentation: {
    noEligibleAgents(): string;
    eligibleAgentHelp(): string;
    noUnsettledDispatches(): string;
    noUnsettledDispatchesHelp(): string;
    inspectionEarlierLines(count: number): string;
    dispatchActive(): string;
    deliveryEchoVerified(): string;
    dispatchDeliveryUnverified(): string;
    reservationsNeverResent(): string;
    dispatchNotSent(): string;
    deliveryRejected(): string;
    dispatchAlreadySettled(outcome: string): string;
    proposalCancelled(): string;
    dispatchResultFallback(): string;
    confirmationResult(status: string, outcome?: string): string;
    blocker(value: string): string;
    resultListLabel(kind: "tests" | "files" | "artifacts"): string;
    resultCounts(files: number, tests: number): string;
    widgetLabel(): string;
    widgetSeparator(): string;
    widgetManagerHint(): string;
    widgetQuiet(): string;
    widgetAutoRun(): string;
    widget(counts: {
      delivering: number;
      active: number;
      attention: number;
      unseenDone: number;
      autoRunArmed: boolean;
      draftTasks?: number;
      reviewTasks?: number;
    }): {
      autoRun?: string;
      delivering?: string;
      running?: string;
      attention?: string;
      done?: string;
      drafts?: string;
      reviews?: string;
      plain: string;
    };
  };
  readonly notification: {
    outcomeTitle(agent: string, outcome: FinalOutcome): string;
    attentionTitle(agent: string): string;
    attentionBody(task: string, condition: string): string;
    autoRunActiveTitle(): string;
    autoRunActiveBody(maxDepth: number): string;
    autoRunDepthExhaustedTitle(agent: string): string;
    autoRunDepthExhaustedBody(task: string): string;
    runQuotaExhaustedTitle(): string;
    runQuotaExhaustedBody(): string;
  };
  readonly tool: {
    label(tool: "propose" | "agents" | "inspect" | "status" | "task-draft"): string;
    taskDraftCreated(title: string): string;
  };
  readonly runtime: {
    dispatchSessionNotStarted(): string;
    dispatchSessionStopped(): string;
    registrySessionNotStarted(): string;
    registrySessionStopped(): string;
    registryUnavailable(): string;
    invalidConfiguration(reason: string): string;
    invalidTeamConfiguration(reason: string): string;
    herdrIdentityUnavailable(): string;
    currentPaneAbsent(): string;
    adapterUnavailable(reason: string): string;
  };
  readonly followup: {
    replyEditor(): string;
    replyCancelled(): string;
    resolutionEvidence(identity: string, tail: string, targetStatus: string, worktree?: string): string;
    emergencyAttestationTitle(): string;
    emergencyAttestationBody(evidence: string, originSessionId: string): string;
    emergencyCancelledBeforeAttestation(): string;
    manualFinalOutcome(): string;
    resolutionCancelled(): string;
    resolutionSummaryEditor(): string;
    reservationReleaseTitle(emergency: boolean): string;
    reservationReleaseBody(evidence: string, outcome: string, emergency: boolean): string;
    resolutionCancelledAtConfirmation(): string;
    settled(agent: string, outcome: string): string;
    alreadySettled(agent: string, outcome: string): string;
    preview(identity: string, tail: string, focusWarning: string, kind: "reply" | "cancel"): string;
    previewWithTechnical(preview: string, dispatchId: string, terminalId: string, payload: string): string;
    previewWithoutTechnical(preview: string): string;
    approvalOptions(technical: boolean): string[];
    approveOption(): string;
    technicalOption(): string;
    hideTechnicalOption(): string;
    cancelOption(): string;
    cancelled(kind: "reply" | "cancel"): string;
    deliveryVerified(kind: "reply" | "cancel"): string;
    deliveryAmbiguous(kind: "reply" | "cancel"): string;
    deliveryNotSent(kind: "reply" | "cancel", reason: string): string;
  };
}

const attentionLabels: Readonly<Record<AttentionCondition, string>> = Object.freeze({
  "target-lost": "目标丢失",
  "delivery-unverified": "投递未验证",
  "malformed-result": "结果格式错误",
  "result-missing": "结果缺失",
  "blocked-runtime": "运行时受阻",
  "monitoring-paused": "监控已暂停",
  overdue: "已超期",
  unacknowledged: "未应答",
});

const outcomeLabels: Readonly<Record<string, string>> = Object.freeze({
  done: "完成",
  blocked: "受阻",
  failed: "失败",
  cancelled: "已取消",
});

const lifecycleLabels: Readonly<Record<string, string>> = Object.freeze({
  proposed: "已提议",
  delivering: "投递中",
  active: "运行中",
  settled: "已结算",
});

const agentStatusLabels: Readonly<Record<string, string>> = Object.freeze({
  idle: "空闲",
  done: "完成",
  working: "工作中",
  blocked: "受阻",
  unknown: "未知",
});

const modeLabels: Readonly<Record<string, string>> = Object.freeze({
  write: "写入",
  "non-mutating": "非变更",
});

const taskStateLabels: Readonly<Record<TaskState, string>> = Object.freeze({
  draft: "草稿",
  queued: "排队",
  dispatched: "已派出",
  review: "待验收",
  accepted: "已验收",
});

const roleLabels: Readonly<Record<string, string>> = Object.freeze({
  coder: "开发",
  reviewer: "评审",
  bugfix: "修bug",
  chore: "杂活",
  researcher: "资料",
  advisor: "顾问",
  oracle: "终审",
});

const parkedReasonLabels: Readonly<Record<TaskParkedReason, string>> = Object.freeze({
  "no-verdict": "评审未给结论",
  "review-failed": "评审未过",
});

const taskWorktreeRefusalLabels: Readonly<Record<TaskWorktreeRefusalReason, string>> =
  Object.freeze({
    "branch-unmerged": "分支未合并",
    "working-tree-dirty": "任务 worktree 有未提交变更",
    "unsettled-dispatch": "仍有未结算派发占用",
    "missing-task-branch": "不是 task/ 分支",
  });

const commandDescriptions: Readonly<Record<HumanCommand, string>> = Object.freeze({
  agents: "列出当前 Herdr 工作区的可用 Agent",
  new: "使用现有 Agent 创建并立即发送一个 Herdr 派发",
  create: "创建一个新 Agent 并立即发送 Herdr 派发",
  clean: "检查并清理已合并的任务 worktree",
  manager: "打开 Herdr 派发管理器",
  auto: "查看或切换自动运行(结算结果自动唤醒模型)",
  task: "创建草稿或打开任务板",
  reply: "预览并确认对一个有待处理状况的运行中派发的回复",
  cancel: "预览并确认一次常规取消请求",
  resolve: "经确认后手动或应急处理一个派发",
  setup: "显式安装一个 Herdr Agent 状态集成",
  output: "读取一次有界的当前工作区 Agent 输出尾部",
});

function duration(minutes: number): string {
  return minutes < 60
    ? `${minutes} 分钟`
    : `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

function followupKind(kind: "reply" | "cancel"): string {
  return kind === "reply" ? "回复" : "取消请求";
}

export const UI_COPY = Object.freeze({
  state: {
    outcome: (outcome) => outcomeLabels[String(outcome)] ?? String(outcome),
    lifecycle: (lifecycle) => lifecycleLabels[String(lifecycle)] ?? String(lifecycle),
    agentStatus: (status) => agentStatusLabels[status] ?? status,
    attention: (condition) => attentionLabels[condition],
    mode: (mode) => modeLabels[mode] ?? mode,
    provenance: (reported) => (reported ? "已上报" : "~屏测"),
    task: (state) => taskStateLabels[state],
    role: (role) => roleLabels[role] ?? role,
    parkedReason: (reason) => parkedReasonLabels[reason],
    workflowStage: (stage, total) => `阶段 ${stage}/${total}`,
  },
  time: {
    relativeDeadline: (deadlineAt, now) => {
      const delta = deadlineAt - now;
      const magnitude = Math.abs(delta);
      if (magnitude < 60_000) return delta >= 0 ? "不足 1 分钟" : "刚刚超期";
      const text = duration(Math.round(magnitude / 60_000));
      return delta >= 0 ? `${text}后` : `超期 ${text}`;
    },
    relativeAge: (timestamp, now) => {
      const magnitude = Math.max(0, now - timestamp);
      if (magnitude < 60_000) return "刚刚";
      return `${duration(Math.round(magnitude / 60_000))}前`;
    },
  },
  count: {
    eligibleAgents: (count) => `${count} 个可用 Agent`,
    unsettledDispatches: (count) => `${count} 条未结算派发`,
    lines: (count) => `${count} 行`,
    earlierLines: (count) => `之前还有 ${count} 行`,
    moreConditions: (count) => `另有 ${count} 项状况`,
    files: (count) => `${count} 个文件`,
    tests: (count) => `${count} 个测试`,
    delivering: (count) => `${count} 投递中`,
    running: (count) => `${count} 运行中`,
    attention: (count) => `${count} 待处理`,
  },
  common: {
    untitledDispatch: () => "未命名派发",
    untitledTask: () => "未命名任务",
    dispatchFallback: () => "派发",
    deadline: (value) => `截止 ${value}`,
    worktree: (value) => `worktree ${value}`,
    dispatch: (value) => `派发 ${value}`,
    terminal: (value) => `终端 ${value}`,
  },
  command: {
    description: (command) => commandDescriptions[command],
    dispatchTuiOnly: () => "派发投递仅在 TUI 模式下可用",
    createTuiOnly: () => "Agent 创建和派发仅在 TUI 模式下可用",
    cleanTuiOnly: () => "任务 worktree 清理仅在 TUI 模式下可用",
    proposalTuiOnly: () => "Herdr 派发投递仅在 TUI 模式下可用",
    managerTuiOnly: () => "派发管理器仅在 TUI 模式下可用",
    setupTuiOnly: () => "集成安装仅在 TUI 模式下可用",
    followupTuiOnly: () => "派发后续操作仅在 TUI 模式下可用",
    noEligibleAgents: () => "当前没有可用 Agent",
    chooseEligibleAgent: () => "选择一个可用 Agent",
    noLaunchableAgents: () =>
      "当前没有可创建的受支持 Agent。集成型 Agent 可先运行 /hd-setup,屏测型 Agent 需要本机标准可执行文件。",
    integrationStatusFailed: (reason) => `无法读取 Herdr 状态集成:${reason}`,
    chooseAgentType: () => "选择要创建的 Agent",
    chooseAgentLayout: () => "选择新 Agent 的布局",
    agentLayout: (layout) => ({
      adaptive: "当前标签页 · 自适应",
      right: "当前标签页 · 左右",
      down: "当前标签页 · 上下",
      "new-tab": "单独标签页",
    })[layout],
    creatingAgent: (agent) => `正在创建并等待 ${agent} Agent…按 Esc 可停止等待。`,
    agentCreationCancelled: (location) =>
      `已停止等待和派发;如窗口已经创建,它会继续保留${location ? `:${location}。` : "。"}`,
    agentCreationFailed: (reason, location) =>
      `Agent 创建或启动失败:${reason} 如窗口已经创建,它会继续保留${location ? `:${location}。` : "。"}`,
    agentCreationPreflightFailed: (reason) => `创建前检查未通过:${reason}`,
    createdResourceLocation: (paneId, tabId, worktreePath) => {
      const parts = [
        paneId && tabId ? `pane ${paneId} · tab ${tabId}` : "",
        worktreePath ? `任务 worktree ${worktreePath}` : "",
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(" · ") : undefined;
    },
    taskWorktreePlacement: () => "选择写入派发的位置",
    newTaskWorktreePlacement: () =>
      "新任务 worktree(默认)· node_modules 等依赖不会带过去,可能需要按本次派发授权重新安装",
    currentDirectoryPlacement: () => "当前目录 · 继续使用共享 worktree",
    taskWorktreeCreationFailed: (reason) =>
      `任务 worktree 创建失败:${reason} 未创建任何 Agent 窗口。`,
    sharedWorktreeHint: () =>
      "目标 Agent 位于源会话的共享 worktree。/hd-create 可创建隔离的任务 worktree;继续会在共享 worktree 写租约上串行执行。",
    noTaskWorktrees: () => "当前仓库没有任务 worktree。",
    chooseTaskWorktreeCleanup: () => "选择要清理的任务 worktree；不可清理项会标出原因",
    cleanAllTaskWorktrees: (count) => `清理全部 ${count} 个可清理项`,
    taskWorktreeCleanupEntry: (path, branch, reasons) =>
      `${path} · ${branch || "无 task/ 分支"}${
        reasons.length === 0 ? " · 可清理" : ` · 拒绝:${reasons.join("、")}`
      }`,
    taskWorktreeRefusalReason: (reason) => taskWorktreeRefusalLabels[reason],
    taskWorktreeCleanupConfirm: (count) => `确认清理 ${count} 个任务 worktree?`,
    taskWorktreeCleanupConfirmBody: (paths) =>
      `将执行非强制 git worktree remove,然后用 git branch -d 删除分支:\n${paths.join("\n")}`,
    taskWorktreeCleanupComplete: (count) => `已清理 ${count} 个任务 worktree。`,
    taskWorktreeCleanupFailed: (path, reason) => `未能清理 ${path}:${reason}`,
    selectedAgentUnavailable: () => "所选 Agent 已不可用",
    completeTask: () => "填写派发任务",
    mutationMode: () => "派发变更模式",
    deadlineMinutes: (defaultMinutes) => `截止时间(分钟,默认 ${defaultMinutes})`,
    dependencyInstallTitle: () => "项目依赖安装",
    dependencyInstallQuestion: () => "是否显式允许在项目内安装依赖?",
    selectedDispatchUnavailable: () => "所选派发已不在当前工作区",
    runtimeUnavailable: () => "派发运行时不可用",
    followupRuntimeUnavailable: () => "派发后续操作运行时不可用",
    invalidDispatchSelector: () => "无效的派发 ID 或前缀",
    dispatchNotFound: (selector) =>
      `当前工作区没有匹配 ${selector} 的派发。请打开 /hd-manager。`,
    chooseMatchingDispatch: () => "选择匹配的派发",
    noDispatchForAction: (action) => {
      switch (action) {
        case "reply":
          return "当前没有需要回复的派发。";
        case "cancel":
          return "本会话没有可取消的未结算派发。";
        case "resolve":
          return "当前没有需要手动处理的派发。";
      }
    },
    alreadySettled: (outcome) =>
      `该派发已结算${outcome ? `:${outcomeLabels[outcome] ?? outcome}` : ""}。`,
    originOnlyFollowup: () => "只有确切的源会话才能回复或请求取消。",
    lostOrMovedResolutionOnly: () => "目标丢失的派发只能手动处理。",
    replyRequiresActive: () => "回复要求派发处于运行中。",
    replyRequiresAttention: () => "回复要求运行中的派发存在待处理状况。",
    setupNoStatusOutput: () => "没有集成状态输出。",
    setupChooseIntegration: () => "安装一个 Herdr 集成",
    setupCancel: () => "取消",
    setupConfirmTitle: (integration) => `安装 Herdr ${integration} 集成?`,
    setupConfirmBody: () =>
      "此操作会显式修改该 Agent 的本地集成配置。不会自动安装任何东西,只会更改这一个所选集成。",
    setupInstallFailed: (code) => `Herdr 集成安装退出码 ${code}`,
    setupInstalled: (integration) => `已安装 Herdr ${integration} 集成。`,
    outputUsage: () => "用法:/hd-output <目标> [行数]",
    followupTask: () => "追加任务(发往同一目标)",
    redispatchTargetBusy: () => "目标 Agent 当前不可用——正在工作、受阻或已被占用。",
    redispatchTargetGone: () => "目标 Agent 已不在当前工作区——它的 pane 可能已被关闭。",
    autoUsage: () => "用法:/hd-auto [on [1-50]|off]",
    autoTuiOnly: () => "自动运行切换仅在 TUI 模式下可用",
    autoStatus: (armed, maxDepth, remainingQuota: number | undefined = undefined) =>
      armed
        ? `⚡自动运行:已开启 · 深度上限 ${maxDepth}${remainingQuota === undefined ? "" : ` · 本次额度剩余 ${remainingQuota}`}。结算结果会自动唤醒模型;达到限制后安静排队等待人工查看。`
        : "自动运行:已关闭。结算结果会安静排队,等你下一次发言时进入上下文。",
    autoEnabled: (maxDepth, remainingQuota: number | undefined = undefined) =>
      `⚡自动运行已开启(本会话持久,resume 后仍然生效)· 深度上限 ${maxDepth}${remainingQuota === undefined ? "" : ` · 本次额度 ${remainingQuota}`}。用 /hd-auto off 关闭。`,
    autoDisabled: () =>
      "自动运行已关闭:之后的结算不再唤醒模型;已在途的唤醒最多还会触发一次。正在运行的回合请用 Esc 中断。",
    taskTuiOnly: () => "任务板操作仅在 TUI 模式下可用",
    taskAction: () => "任务板",
    taskManualEntry: () => "手动添加草稿",
    taskOpenBoard: () => "查看任务板",
    taskTitle: () => "任务标题",
    taskText: () => "填写完整任务",
    taskPreferredWorktree: () => "选择偏好的任务 worktree(可选)",
    taskNoPreferredWorktree: () => "不指定",
    taskRole: () => "选择角色(可跳过)",
    taskNoRole: () => "不指定角色",
    taskWorkflow: () => "选择工作流",
    taskAutomaticWorkflow: (workflow) => workflow ? `按角色自动(${workflow})` : "单阶段(默认)",
    taskWorkflowOption: (workflow) => `工作流 ${workflow}`,
    taskDraftCreated: () => "任务草稿已创建,等待批准。",
    tasksApproved: (count) => `已批准 ${count} 个任务并加入排队。`,
    tasksAccepted: (count) => `已验收 ${count} 个任务。`,
    taskDraftDeleted: () => "任务草稿已删除。",
    taskDeleteConfirm: (title) => `删除草稿“${title}”?`,
    taskDeleteConfirmBody: () => "此操作会永久删除该草稿并记录审计事件。",
    taskDemoteConfirm: (title) => `将排队任务“${title}”撤回草稿?`,
    taskDemoteConfirmBody: () => "撤回后任务会回到草稿,之后可以重新批准或删除。",
    taskDemoted: () => "任务已撤回草稿。",
    selectedTaskUnavailable: () => "所选任务已不在任务板中",
    taskReturnFeedback: () => "填写打回意见",
    taskReturned: () => "任务已打回并重新排队。",
    runQuotaExhausted: () => "本次额度已用完,任务继续排队等待重新开启自动运行。",
    taskDraftInvalid: () => "任务草稿无效。标题最多 80 个字符,任务最多 4000 个字符。",
    taskOperationFailed: () => "任务板状态已变化,本次操作未生效。请重新打开任务板。",
  },
  manager: {
    title: () => "任务派发",
    detailTitle: () => "派发详情",
    heading: (
      running,
      delivering,
      attention,
      autoRunArmed = false,
      draftTasks = 0,
      reviewTasks = 0,
      remainingQuota: number | undefined = undefined,
    ) =>
      [
        autoRunArmed ? "⚡自动" : "",
        autoRunArmed && remainingQuota !== undefined ? `本次额度 ${remainingQuota}` : "",
        draftTasks > 0 ? `${draftTasks} 草稿待批` : "",
        reviewTasks > 0 ? `${reviewTasks} 待验收` : "",
        running > 0 ? `${running} 运行中` : "",
        delivering > 0 ? `${delivering} 投递中` : "",
        attention > 0 ? `${attention} 待处理` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    groupAttention: () => "待处理",
    groupRunning: () => "运行中",
    groupDelivering: () => "投递中",
    groupUnseenSettled: () => "已完成 · 未读",
    taskBoardHeading: () => "任务板",
    taskGroup: (state) => taskStateLabels[state],
    settledHeading: (count, shown) =>
      shown ? `已结算 · 最近 ${count} 条` : `已结算 · ${count} 条`,
    listKeybar: (settledShown, hasUnseen, hasTasks = false) =>
      [
        "enter 详情",
        hasTasks ? "space 选择 · a 全选 · A 反选 · enter 提交 · x 单项" : "",
        hasUnseen ? "c 清空未读" : "",
        `s ${settledShown ? "隐藏" : "显示"}已结算`,
      ]
        .filter(Boolean)
        .join(" · "),
    emergencyResolutionRequired: () => "需要应急处理",
    activeSince: (age) => `运行开始于${age}`,
    deliveryStarted: (age) => `投递开始于${age}`,
    targetMayHaveReceivedInput: () => "回显虽已丢失,目标仍可能收到了输入。",
    reservationsRetained: () => "预留已保留 · 绝不自动重发",
    outputNoneRead: () => " ── 输出 · 尚未读取 ──",
    outputReadInstructions: () => "    按 r 读取一次 50 行,或按 R 读取 200 行。",
    outputReading: (lines) => ` ── 输出 · 正在读取 ${lines} 行… ──`,
    outputReadFailed: () => " ── 输出 · 读取失败 ──",
    outputEarlierLinesNotShown: (count) => ` … 之前 ${count} 行未显示`,
    outputReadEnd: (time) => ` ── 结束 · 读取于 ${time} · 仅按需读取 ──`,
    detailKeybar: (actions, redispatch = false) => {
      const labels = [
        actions.includes("reply") ? "y 回复" : "",
        actions.includes("cancel") ? "c 取消" : "",
        actions.includes("resolve") ? "v 处理" : "",
        redispatch ? "f 追加派发" : "",
      ].filter(Boolean);
      return ` r/R 读输出${labels.length > 0 ? ` · ${labels.join(" · ")}` : ""} · D 详情`;
    },
    technicalHeading: () => " 技术详情",
    technicalLabel: (label) => ({
      dispatch: "派发 ID",
      terminal: "终端",
      origin: "源会话",
      workspace: "工作区",
      worktree: "任务 worktree",
    })[label],
    viewUnavailable: (reason) => ` 派发视图不可用:${reason}`,
    closeKeybar: () => " esc 关闭",
    missingRegistryDispatch: () => " 该派发已不在注册表中",
    backKeybar: () => " esc 返回",
  },
  presentation: {
    noEligibleAgents: () => "当前没有可用 Agent——其余的正在工作、受阻或已被占用。",
    eligibleAgentHelp: () => "Agent 的状态为空闲或完成时即成为可用 Agent。",
    noUnsettledDispatches: () => "没有未结算的派发。",
    noUnsettledDispatchesHelp: () => "用 /hd-new 发起一个,或直接让模型派发工作。",
    inspectionEarlierLines: (count) => `… 之前还有 ${count} 行(展开查看)`,
    dispatchActive: () => "派发运行中",
    deliveryEchoVerified: () => "· 投递回显已验证",
    dispatchDeliveryUnverified: () => "派发投递未验证",
    reservationsNeverResent: () => "   预留已保留 · 绝不自动重发",
    dispatchNotSent: () => "派发未发送",
    deliveryRejected: () => "投递被拒绝",
    dispatchAlreadySettled: (outcome) => `派发已结算:${outcome}`,
    proposalCancelled: () => "○ 提议已取消——未发送任何内容",
    dispatchResultFallback: () => "派发结果",
    confirmationResult: (status, outcome) => {
      if (status === "active") return "派发正在运行;投递回显已验证。";
      if (status === "delivery-unverified") {
        return "派发投递未验证。预留已保留,绝不会自动重发。";
      }
      if (status === "failed") return "已证实派发未发送,记录为失败。";
      if (status === "already-settled") {
        return `派发此前已结算;记录的最终结果为${String(outcome)}。`;
      }
      return "派发提议已取消,未进行投递。";
    },
    blocker: (value) => `阻碍:${value}`,
    resultListLabel: (kind) =>
      ({ tests: "测试", files: "文件", artifacts: "产物" })[kind],
    resultCounts: (files, tests) =>
      [files > 0 ? `${files} 个文件` : "", tests > 0 ? `${tests} 个测试` : ""]
        .filter(Boolean)
        .join(" · ") + "(展开查看详情)",
    widgetLabel: () => "派发",
    widgetSeparator: () => "  ·  ",
    widgetManagerHint: () => "  ·  alt+h",
    widgetQuiet: () => "派发 · alt+h",
    widgetAutoRun: () => "⚡自动",
    widget: (counts) => {
      const autoRun = counts.autoRunArmed ? "⚡自动" : undefined;
      const delivering = counts.delivering > 0 ? `${counts.delivering} 投递中` : undefined;
      const running = counts.active > 0 ? `${counts.active} 运行中` : undefined;
      const attention = counts.attention > 0 ? `${counts.attention} 待处理` : undefined;
      const done = counts.unseenDone > 0 ? `${counts.unseenDone} 已完成` : undefined;
      const drafts = (counts.draftTasks ?? 0) > 0 ? `${counts.draftTasks} 草稿待批` : undefined;
      const reviews = (counts.reviewTasks ?? 0) > 0 ? `${counts.reviewTasks} 待验收` : undefined;
      const plainSegments = [drafts, reviews, delivering, running, attention, done].filter(
        (segment): segment is string => segment !== undefined,
      );
      const label = autoRun ? `派发 ${autoRun}` : "派发";
      return {
        autoRun,
        delivering,
        running,
        attention,
        done,
        drafts,
        reviews,
        plain:
          plainSegments.length === 0
            ? `${label} · alt+h`
            : `${label}: ${plainSegments.join(" · ")}`,
      };
    },
  },
  notification: {
    outcomeTitle: (agent, outcome) => `${agent} ${outcomeLabels[outcome] ?? outcome}`,
    attentionTitle: (agent) => `${agent} 需要处理`,
    attentionBody: (task, condition) => `${task} · ${condition}`,
    autoRunActiveTitle: () => "自动运行已启用",
    autoRunActiveBody: (maxDepth) =>
      `本会话的结算结果会自动唤醒模型;深度上限 ${maxDepth}。用 /hd-auto off 关闭。`,
    autoRunDepthExhaustedTitle: (agent) => `${agent} 完成 · 自动运行深度已达上限`,
    autoRunDepthExhaustedBody: (task) => `${task} · 结果已排队,等待人工查看`,
    runQuotaExhaustedTitle: () => "本次额度已用完",
    runQuotaExhaustedBody: () => "排队任务保持不变;用 /hd-auto on [额度] 重新开启。",
  },
  tool: {
    label: (tool) => ({
      propose: "提议 Herdr 派发",
      agents: "列出 Herdr Agent",
      inspect: "查看 Herdr Agent 输出",
      status: "Herdr 派发状态",
      "task-draft": "创建任务草稿",
    })[tool],
    taskDraftCreated: (title) => `✓ 任务草稿“${title}”已创建,等待批准`,
  },
  runtime: {
    dispatchSessionNotStarted: () => "派发运行时会话尚未启动",
    dispatchSessionStopped: () => "派发运行时会话已停止",
    registrySessionNotStarted: () => "派发注册表会话尚未启动",
    registrySessionStopped: () => "派发注册表会话已停止",
    registryUnavailable: () => "派发注册表不可用",
    invalidConfiguration: (reason) => `派发配置无效:${reason}`,
    invalidTeamConfiguration: (reason) => `团队配置无效:${reason}。带角色或工作流的任务已停止派发。`,
    herdrIdentityUnavailable: () => "Herdr 套接字、工作区或当前 pane 身份不可用",
    currentPaneAbsent: () => "当前 Pi pane 不在捕获的 Herdr 工作区中",
    adapterUnavailable: (reason) => `Herdr 适配器不可用:${reason}`,
  },
  followup: {
    replyEditor: () => "回复派发目标",
    replyCancelled: () => "回复已取消。",
    resolutionEvidence: (identity, tail, targetStatus, worktree) =>
      `${identity}\n\n${tail}\n目标状态:${targetStatus}\nWorktree:${worktree ?? "无"}`,
    emergencyAttestationTitle: () => "应急处理声明",
    emergencyAttestationBody: (evidence, originSessionId) =>
      `${evidence}\n\n源会话:${originSessionId}\n请声明:你已亲自判断该源会话不可用。系统未做任何进程存活推断。`,
    emergencyCancelledBeforeAttestation: () => "应急处理在声明前已取消。",
    manualFinalOutcome: () => "手动最终结果",
    resolutionCancelled: () => "处理已取消。",
    resolutionSummaryEditor: () => "有界的处理摘要",
    reservationReleaseTitle: (emergency) =>
      emergency ? "确认应急释放预留" : "确认手动释放预留",
    reservationReleaseBody: (evidence, outcome, emergency) =>
      `${evidence}\n\n记录${outcome},原子释放全部预留,并接受先到先赢的结算?${
        emergency ? "此操作不会转移监控,也不会向本处理会话注入上下文。" : ""
      }`,
    resolutionCancelledAtConfirmation: () => "处理在最终确认时已取消。",
    settled: (agent, outcome) =>
      `${agent} 的派发已结算:${outcomeLabels[outcome] ?? outcome}。`,
    alreadySettled: (agent, outcome) =>
      `${agent} 的派发此前已结算:${outcomeLabels[outcome] ?? outcome};以先完成的结算为准。`,
    preview: (identity, tail, focusWarning, kind) =>
      `${identity}\n\n${tail}\n\n${focusWarning}\n\n${
        kind === "reply"
          ? "确认后的回复不会释放任何预留。"
          : "这只发送一次常规取消请求,绝不发送 Ctrl+C。预留将保留至结算。"
      }`,
    previewWithTechnical: (preview, dispatchId, terminalId, payload) =>
      `${preview}\n\n技术详情:\n派发 ID:${dispatchId}\n目标终端:${terminalId}\n\n确切的出站字节:\n${payload}`,
    previewWithoutTechnical: (preview) =>
      `${preview}\n\n技术详情已隐藏。选择"技术详情"可查看确切的协议字节。`,
    approvalOptions: (technical) => [
      "批准",
      technical ? "隐藏技术详情" : "技术详情",
      "取消",
    ],
    approveOption: () => "批准",
    technicalOption: () => "技术详情",
    hideTechnicalOption: () => "隐藏技术详情",
    cancelOption: () => "取消",
    cancelled: (kind) => `${followupKind(kind)}已取消。`,
    deliveryVerified: (kind) => `${followupKind(kind)}的投递回显已验证。`,
    deliveryAmbiguous: (kind) => `${followupKind(kind)}的投递不明确;未重发。`,
    deliveryNotSent: (kind, reason) => `已证实${followupKind(kind)}未发送:${reason}。`,
  },
} satisfies HumanUiCopy);
