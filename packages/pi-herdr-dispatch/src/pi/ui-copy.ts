import type {
  AttentionCondition,
  DispatchLifecycle,
  DispatchMode,
  FinalOutcome,
} from "../registry/types.js";

export type HumanDispatchAction = "reply" | "cancel" | "resolve";
export type HumanCommand =
  | "agents"
  | "new"
  | "manager"
  | "reply"
  | "cancel"
  | "resolve"
  | "setup"
  | "output";
export type TechnicalLabel = "dispatch" | "terminal" | "origin" | "workspace";

export interface HumanUiCopy {
  readonly state: {
    outcome(outcome: FinalOutcome | string): string;
    lifecycle(lifecycle: DispatchLifecycle | string): string;
    agentStatus(status: string): string;
    attention(condition: AttentionCondition): string;
    mode(mode: DispatchMode): string;
    provenance(reported: boolean): string;
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
    dispatchFallback(): string;
    deadline(value: string): string;
    worktree(value: string): string;
    dispatch(value: string): string;
    terminal(value: string): string;
  };
  readonly command: {
    description(command: HumanCommand): string;
    dispatchTuiOnly(): string;
    proposalTuiOnly(): string;
    managerTuiOnly(): string;
    setupTuiOnly(): string;
    followupTuiOnly(): string;
    noEligibleAgents(): string;
    chooseEligibleAgent(): string;
    selectedAgentUnavailable(): string;
    completeTask(): string;
    mutationMode(): string;
    deadlineMinutes(): string;
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
  };
  readonly manager: {
    title(): string;
    detailTitle(): string;
    heading(running: number, delivering: number, attention: number): string;
    noActiveDispatches(): string;
    startWithCommand(): string;
    groupAttention(): string;
    groupRunning(): string;
    groupDelivering(): string;
    settledHeading(count: number, shown: boolean): string;
    listKeybar(settledShown: boolean): string;
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
    detailKeybar(actions: readonly HumanDispatchAction[]): string;
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
    widget(counts: { delivering: number; active: number; attention: number }): {
      delivering?: string;
      running?: string;
      attention?: string;
      plain: string;
    };
  };
  readonly notification: {
    outcomeTitle(agent: string, outcome: FinalOutcome): string;
    attentionTitle(agent: string): string;
    attentionBody(task: string, condition: string): string;
  };
  readonly tool: {
    label(tool: "propose" | "agents" | "inspect" | "status"): string;
  };
  readonly runtime: {
    dispatchSessionNotStarted(): string;
    dispatchSessionStopped(): string;
    registrySessionNotStarted(): string;
    registrySessionStopped(): string;
    registryUnavailable(): string;
    invalidConfiguration(reason: string): string;
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

const commandDescriptions: Readonly<Record<HumanCommand, string>> = Object.freeze({
  agents: "列出当前 Herdr 工作区的可用 Agent",
  new: "创建并立即发送一个 Herdr 派发",
  manager: "打开 Herdr 派发管理器",
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
    dispatchFallback: () => "派发",
    deadline: (value) => `截止 ${value}`,
    worktree: (value) => `worktree ${value}`,
    dispatch: (value) => `派发 ${value}`,
    terminal: (value) => `终端 ${value}`,
  },
  command: {
    description: (command) => commandDescriptions[command],
    dispatchTuiOnly: () => "派发投递仅在 TUI 模式下可用",
    proposalTuiOnly: () => "Herdr 派发投递仅在 TUI 模式下可用",
    managerTuiOnly: () => "派发管理器仅在 TUI 模式下可用",
    setupTuiOnly: () => "集成安装仅在 TUI 模式下可用",
    followupTuiOnly: () => "派发后续操作仅在 TUI 模式下可用",
    noEligibleAgents: () => "当前没有可用 Agent",
    chooseEligibleAgent: () => "选择一个可用 Agent",
    selectedAgentUnavailable: () => "所选 Agent 已不可用",
    completeTask: () => "填写派发任务",
    mutationMode: () => "派发变更模式",
    deadlineMinutes: () => "截止时间(分钟)",
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
  },
  manager: {
    title: () => "Herdr 派发",
    detailTitle: () => "派发详情",
    heading: (running, delivering, attention) =>
      [
        running > 0 ? `${running} 运行中` : "",
        delivering > 0 ? `${delivering} 投递中` : "",
        attention > 0 ? `${attention} 待处理` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    noActiveDispatches: () => "没有活跃的派发",
    startWithCommand: () => "用 /hd-new 发起一个",
    groupAttention: () => "待处理",
    groupRunning: () => "运行中",
    groupDelivering: () => "投递中",
    settledHeading: (count, shown) =>
      shown ? `已结算 · 最近 ${count} 条` : `已结算 · ${count} 条已隐藏 · 按 S 显示`,
    listKeybar: (settledShown) =>
      `enter 详情 · s ${settledShown ? "隐藏" : "显示"}已结算`,
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
    detailKeybar: (actions) => {
      const labels = [
        actions.includes("reply") ? "y 回复" : "",
        actions.includes("cancel") ? "c 取消" : "",
        actions.includes("resolve") ? "v 处理" : "",
      ].filter(Boolean);
      return ` r/R 读输出${labels.length > 0 ? ` · ${labels.join(" · ")}` : ""} · D 详情`;
    },
    technicalHeading: () => " 技术详情",
    technicalLabel: (label) => ({
      dispatch: "派发 ID",
      terminal: "终端",
      origin: "源会话",
      workspace: "工作区",
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
    widget: (counts) => {
      const delivering = counts.delivering > 0 ? `${counts.delivering} 投递中` : undefined;
      const running = counts.active > 0 ? `${counts.active} 运行中` : undefined;
      const attention = counts.attention > 0 ? `${counts.attention} 待处理` : undefined;
      const plainSegments = [delivering, running, attention].filter(
        (segment): segment is string => segment !== undefined,
      );
      return {
        delivering,
        running,
        attention,
        plain: plainSegments.length === 0 ? "派发 · alt+h" : `派发: ${plainSegments.join(" · ")}`,
      };
    },
  },
  notification: {
    outcomeTitle: (agent, outcome) => `${agent} ${outcomeLabels[outcome] ?? outcome}`,
    attentionTitle: (agent) => `${agent} 需要处理`,
    attentionBody: (task, condition) => `${task} · ${condition}`,
  },
  tool: {
    label: (tool) => ({
      propose: "提议 Herdr 派发",
      agents: "列出 Herdr Agent",
      inspect: "查看 Herdr Agent 输出",
      status: "Herdr 派发状态",
    })[tool],
  },
  runtime: {
    dispatchSessionNotStarted: () => "派发运行时会话尚未启动",
    dispatchSessionStopped: () => "派发运行时会话已停止",
    registrySessionNotStarted: () => "派发注册表会话尚未启动",
    registrySessionStopped: () => "派发注册表会话已停止",
    registryUnavailable: () => "派发注册表不可用",
    invalidConfiguration: (reason) => `派发配置无效:${reason}`,
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
