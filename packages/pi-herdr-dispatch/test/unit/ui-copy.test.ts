import { describe, expect, it } from "vitest";

import { UI_COPY } from "../../src/pi/ui-copy.js";

describe("human UI copy catalog", () => {
  it("defines the exact state and attention vocabulary", () => {
    expect([
      UI_COPY.state.outcome("done"),
      UI_COPY.state.outcome("blocked"),
      UI_COPY.state.outcome("failed"),
      UI_COPY.state.outcome("cancelled"),
      UI_COPY.state.lifecycle("delivering"),
      UI_COPY.state.lifecycle("active"),
      UI_COPY.state.agentStatus("idle"),
      UI_COPY.state.agentStatus("done"),
      UI_COPY.state.agentStatus("working"),
      UI_COPY.state.agentStatus("blocked"),
    ]).toEqual([
      "完成",
      "受阻",
      "失败",
      "已取消",
      "投递中",
      "运行中",
      "空闲",
      "完成",
      "工作中",
      "受阻",
    ]);
    expect(["draft", "queued", "dispatched", "review", "accepted"].map(
      (state) => UI_COPY.state.task(state as never),
    )).toEqual(["草稿", "排队", "已派出", "待验收", "已验收"]);
    expect(["coder", "reviewer", "bugfix", "chore", "researcher", "advisor", "oracle"].map(
      (role) => UI_COPY.state.role(role),
    )).toEqual(["开发", "评审", "修bug", "杂活", "资料", "顾问", "终审"]);
    expect(UI_COPY.state.parkedReason("no-verdict")).toBe("评审未给结论");
    expect(UI_COPY.state.parkedReason("review-failed")).toBe("评审未过");
    expect(UI_COPY.state.workflowStage(2, 2)).toBe("阶段 2/2");
    expect([
      "target-lost",
      "delivery-unverified",
      "malformed-result",
      "result-missing",
      "blocked-runtime",
      "monitoring-paused",
      "overdue",
      "unacknowledged",
    ].map((condition) => UI_COPY.state.attention(condition as never))).toEqual([
      "目标丢失",
      "投递未验证",
      "结果格式错误",
      "结果缺失",
      "运行时受阻",
      "监控已暂停",
      "已超期",
      "未应答",
    ]);
  });

  it("builds exact relative-time and count copy", () => {
    expect(UI_COPY.time.relativeDeadline(1_000_000 + 22 * 60_000, 1_000_000)).toBe("22 分钟后");
    expect(UI_COPY.time.relativeDeadline(1_000_000, 1_000_000 + 8 * 60_000)).toBe("超期 8 分钟");
    expect(UI_COPY.time.relativeDeadline(1_000_000 + 125 * 60_000, 1_000_000)).toBe(
      "2 小时 05 分后",
    );
    expect(UI_COPY.time.relativeAge(1_000_000, 1_000_000)).toBe("刚刚");
    expect(UI_COPY.time.relativeAge(1_000_000, 1_000_000 + 125 * 60_000)).toBe("2 小时 05 分前");
    expect(UI_COPY.count.eligibleAgents(1)).toBe("1 个可用 Agent");
    expect(UI_COPY.count.eligibleAgents(2)).toBe("2 个可用 Agent");
    expect(UI_COPY.count.unsettledDispatches(1)).toBe("1 条未结算派发");
    expect(UI_COPY.count.unsettledDispatches(2)).toBe("2 条未结算派发");
    expect(UI_COPY.count.files(2)).toBe("2 个文件");
    expect(UI_COPY.count.tests(3)).toBe("3 个测试");
  });

  it("contains exact command and Dispatch Manager messages", () => {
    expect(UI_COPY.command.description("manager")).toBe("打开 Herdr 派发管理器");
    expect(UI_COPY.command.chooseEligibleAgent()).toBe("选择一个可用 Agent");
    expect(UI_COPY.command.noDispatchForAction("reply")).toBe("当前没有需要回复的派发。");
    expect(UI_COPY.command.noDispatchForAction("cancel")).toBe(
      "本会话没有可取消的未结算派发。",
    );
    expect(UI_COPY.command.noDispatchForAction("resolve")).toBe(
      "当前没有需要手动处理的派发。",
    );
    expect(UI_COPY.manager.heading(2, 1, 3)).toBe("2 运行中 · 1 投递中 · 3 待处理");
    expect(UI_COPY.manager.settledHeading(2, false)).toBe("已结算 · 2 条");
    expect(UI_COPY.manager.settledHeading(2, true)).toBe("已结算 · 最近 2 条");
    expect(UI_COPY.manager.listKeybar(false, false)).toBe("enter 详情 · s 显示已结算");
    expect(UI_COPY.manager.listKeybar(false, true)).toBe(
      "enter 详情 · c 清空未读 · s 显示已结算",
    );
    expect(UI_COPY.manager.heading(0, 0, 0)).toBe("");
    expect(UI_COPY.manager.heading(2, 0, 0, true)).toBe("⚡自动 · 2 运行中");
    expect(UI_COPY.manager.heading(0, 0, 0, true)).toBe("⚡自动");
    expect(UI_COPY.manager.heading(0, 0, 0, true, 2, 1, 7)).toBe(
      "⚡自动 · 本次额度 7 · 2 草稿待批 · 1 待验收",
    );
    expect(UI_COPY.command.description("task")).toBe("创建草稿或打开任务板");
    expect(UI_COPY.command.taskDemoteConfirm("整理任务")).toBe(
      "将排队任务“整理任务”撤回草稿?",
    );
    expect(UI_COPY.command.taskDemoteConfirmBody()).toContain("重新批准或删除");
    expect(UI_COPY.command.taskDemoted()).toBe("任务已撤回草稿。");
    expect(UI_COPY.command.autoStatus(false, 5, 7)).not.toContain("本次额度");
    expect(UI_COPY.command.autoStatus(true, 5, 7, 2)).toContain("创建额度剩余 2");
    expect(UI_COPY.command.autoStatus(false, 5, 7, 2)).not.toContain("创建额度");
    expect(UI_COPY.manager.technicalLabel("workspace")).toBe("工作区");
    expect(UI_COPY.manager.technicalLabel("worktree")).toBe("任务 worktree");
    expect(UI_COPY.command.newTaskWorktreePlacement()).toContain("node_modules 等依赖不会带过去");
    expect(UI_COPY.command.taskWorktreeRefusalReason("branch-unmerged")).toBe("分支未合并");
  });

  it("contains exact Settings panel copy", () => {
    expect(UI_COPY.command.description("settings")).toBe("打开 Herdr 设置");
    expect(UI_COPY.command.settingsTuiOnly()).toBe("设置仅在 TUI 模式下可用");
    expect([
      UI_COPY.settings.title(),
      UI_COPY.settings.runtimeGroup(),
      UI_COPY.settings.rolesGroup(),
      UI_COPY.settings.runQuota(),
      UI_COPY.settings.launchBudget(),
      UI_COPY.settings.autoRunDepth(),
      UI_COPY.settings.deadlineMinutes(),
    ]).toEqual([
      "设置",
      "运行设置",
      "角色模型",
      "本次额度",
      "创建额度",
      "自动接力深度",
      "默认截止分钟",
    ]);
    expect(UI_COPY.settings.keybar()).toBe("↑↓ 选择 · ←→ 调整 · esc 关闭");
    expect(UI_COPY.settings.saveFailed("permission denied")).toBe(
      "保存失败:permission denied",
    );
  });

  it("contains exact human renderer, notification, and follow-up copy", () => {
    expect(UI_COPY.presentation.noEligibleAgents()).toBe(
      "当前没有可用 Agent——其余的正在工作、受阻或已被占用。",
    );
    expect(UI_COPY.presentation.dispatchActive()).toBe("派发运行中");
    expect(UI_COPY.presentation.deliveryEchoVerified()).toBe("· 投递回显已验证");
    expect(UI_COPY.presentation.resultCounts(2, 3)).toBe("2 个文件 · 3 个测试(展开查看详情)");
    expect(UI_COPY.notification.outcomeTitle("claude", "done")).toBe("claude 完成");
    expect(UI_COPY.notification.attentionTitle("claude")).toBe("claude 需要处理");
    expect(UI_COPY.notification.readonlyAgentLaunchedTitle()).toBe("已创建只读角色窗格");
    expect(UI_COPY.notification.readonlyAgentLaunchedBody("评审", "claude", "reviewer-auto-1"))
      .toContain("评审 · claude · reviewer-auto-1");
    expect(UI_COPY.notification.launchBudgetExhaustedTitle()).toBe("创建额度已用完");
    expect(UI_COPY.notification.autoRunDepthExhaustedTitle("claude")).toBe(
      "claude 完成 · 自动接力深度已达上限",
    );
    expect(UI_COPY.followup.replyCancelled()).toBe("回复已取消。");
    expect(UI_COPY.followup.deliveryVerified("reply")).toBe("回复的投递回显已验证。");
    expect(UI_COPY.followup.settled("claude", "受阻")).toBe("claude 的派发已结算:受阻。");
  });
});
