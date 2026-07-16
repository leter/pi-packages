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
    expect(UI_COPY.manager.technicalLabel("workspace")).toBe("工作区");
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
    expect(UI_COPY.followup.replyCancelled()).toBe("回复已取消。");
    expect(UI_COPY.followup.deliveryVerified("reply")).toBe("回复的投递回显已验证。");
    expect(UI_COPY.followup.settled("claude", "受阻")).toBe("claude 的派发已结算:受阻。");
  });
});
