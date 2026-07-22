import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTitleDecisionPrompt,
  createSessionTitleExtension,
  normalizeInstructionInput,
  parseTitleDecision,
  resolveFactoryByok,
  type TitleClassifier,
  type TitleDecision,
} from "../herdr-session-title.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(classify: TitleClassifier, entries: unknown[] = []) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const titles: string[] = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  let sessionName: string | undefined;
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(value: string) {
      sessionName = value;
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
  };
  const ctx = {
    ui: { setTitle(value: string) { titles.push(value); } },
    sessionManager: { getBranch() { return entries; } },
  };
  createSessionTitleExtension(classify)(pi as any);
  return {
    handlers,
    titles,
    appended,
    getSessionName: () => sessionName,
    setSessionName: (value: string) => { sessionName = value; },
    ctx,
  };
}

test("normalizes human input but ignores commands and shell input", () => {
  assert.equal(normalizeInstructionInput("  修复第二行标题  "), "修复第二行标题");
  assert.equal(normalizeInstructionInput("/reload"), undefined);
  assert.equal(normalizeInstructionInput("!git status"), undefined);
  assert.equal(normalizeInstructionInput("继续"), undefined);
  assert.equal(normalizeInstructionInput("好的。"), undefined);
  assert.equal(normalizeInstructionInput("提交"), "提交");
});

test("parses strict keep and update decisions", () => {
  assert.deepEqual(parseTitleDecision('{"action":"keep"}'), { action: "keep" });
  assert.deepEqual(
    parseTitleDecision('```json\n{"action":"update","title":"▸ 调整第二行标题"}\n```'),
    { action: "update", title: "调整第二行标题" },
  );
  assert.equal(parseTitleDecision('{"action":"update","title":""}'), undefined);
  const long = parseTitleDecision('{"action":"update","title":"一二三四五六七八九十甲乙丙丁戊己庚辛"}');
  assert.deepEqual(long, { action: "update", title: "一二三四五六七八九十甲乙丙…" });
});

test("decision prompt contains current title and new input", () => {
  const prompt = buildTitleDecisionPrompt("继续", "调整Agent列表");
  assert.match(prompt, /<current-title>调整Agent列表<\/current-title>/);
  assert.match(prompt, /<new-input>继续<\/new-input>/);
});

test("resolves Droid BYOK credentials without copying them into source", () => {
  const settings = [{ customModels: [
    { model: "gpt-5.6-sol", provider: "openai", baseUrl: "http://127.0.0.1:8317/v1/", apiKey: "${CLIPROXY_KEY}" },
  ] }];
  assert.deepEqual(resolveFactoryByok(settings, { CLIPROXY_KEY: "secret" }), {
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: "secret",
  });
});

test("prefers an explicit gpt-5.4-mini Droid model", () => {
  const settings = [{ customModels: [
    { model: "gpt-5.6-sol", provider: "openai", baseUrl: "https://fallback.test/v1", apiKey: "fallback" },
    { model: "gpt-5.4-mini", provider: "openai", baseUrl: "https://title.test/v1", apiKey: "title" },
  ] }];
  assert.deepEqual(resolveFactoryByok(settings), {
    baseUrl: "https://title.test/v1",
    apiKey: "title",
  });
});

test("AI updates concrete instructions and keeps acknowledgements", async () => {
  const classify: TitleClassifier = async (input) => input === "继续"
    ? { action: "keep" }
    : { action: "update", title: input === "第一条" ? "调整Agent列表" : "给标题增加前缀" };
  const h = harness(classify);
  h.handlers.get("session_start")?.({}, h.ctx);

  h.handlers.get("input")?.({ text: "第一条", source: "interactive" }, h.ctx);
  await flush();
  assert.equal(h.getSessionName(), "调整Agent列表");
  assert.deepEqual(h.titles, ["调整Agent列表"]);

  h.handlers.get("input")?.({ text: "继续", source: "interactive" }, h.ctx);
  await flush();
  assert.deepEqual(h.titles, ["调整Agent列表"]);

  h.handlers.get("input")?.({ text: "第二条", source: "interactive" }, h.ctx);
  await flush();
  assert.deepEqual(h.titles, ["调整Agent列表", "给标题增加前缀"]);
  assert.equal(h.appended.length, 2);
});

test("classifier failure leaves an initial title blank and keeps the last valid title", async () => {
  const classify: TitleClassifier = async () => { throw new Error("unavailable"); };

  const empty = harness(classify);
  empty.handlers.get("session_start")?.({}, empty.ctx);
  empty.handlers.get("input")?.({ text: "New work", source: "interactive" }, empty.ctx);
  await flush();
  assert.deepEqual(empty.titles, []);
  assert.deepEqual(empty.appended, []);

  const existing = harness(classify);
  existing.handlers.get("session_start")?.({}, existing.ctx);
  existing.setSessionName("Existing title");
  existing.handlers.get("session_info_changed")?.({ name: "Existing title" }, existing.ctx);
  existing.handlers.get("input")?.({ text: "New work", source: "interactive" }, existing.ctx);
  await flush();
  assert.equal(existing.getSessionName(), "Existing title");
  assert.deepEqual(existing.titles, ["Existing title"]);
  assert.deepEqual(existing.appended, []);
});

test("stops classifying after three consecutive failures in one session", async () => {
  let calls = 0;
  const classify: TitleClassifier = async () => {
    calls += 1;
    throw new Error("unavailable");
  };
  const h = harness(classify);
  h.handlers.get("session_start")?.({}, h.ctx);
  for (const text of ["First", "Second", "Third", "Fourth"]) {
    h.handlers.get("input")?.({ text, source: "interactive" }, h.ctx);
    await flush();
  }
  assert.equal(calls, 3);

  h.handlers.get("session_start")?.({}, h.ctx);
  h.handlers.get("input")?.({ text: "After reload", source: "interactive" }, h.ctx);
  await flush();
  assert.equal(calls, 4);
});

test("a successful title decision resets the consecutive failure count", async () => {
  let calls = 0;
  const decisions: Array<TitleDecision | Error> = [
    new Error("one"),
    new Error("two"),
    { action: "keep" },
    new Error("one again"),
    new Error("two again"),
    { action: "keep" },
  ];
  const classify: TitleClassifier = async () => {
    calls += 1;
    const decision = decisions.shift();
    if (decision instanceof Error) throw decision;
    return decision ?? { action: "keep" };
  };
  const h = harness(classify);
  h.handlers.get("session_start")?.({}, h.ctx);
  for (const text of ["One", "Two", "Success", "Three", "Four", "Still enabled"]) {
    h.handlers.get("input")?.({ text, source: "interactive" }, h.ctx);
    await flush();
  }
  assert.equal(calls, 6);
});

test("queued decisions see the preceding effective title", async () => {
  const seen: Array<string | undefined> = [];
  const classify: TitleClassifier = async (input, currentTitle) => {
    seen.push(currentTitle);
    return { action: "update", title: input };
  };
  const h = harness(classify);
  h.handlers.get("session_start")?.({}, h.ctx);
  h.handlers.get("input")?.({ text: "First", source: "interactive" }, h.ctx);
  h.handlers.get("input")?.({ text: "Second", source: "interactive" }, h.ctx);
  await flush();
  await flush();
  assert.deepEqual(seen, [undefined, "First"]);
  assert.deepEqual(h.titles, ["First", "Second"]);
});

test("restores the latest persisted activity title", () => {
  const entries = [{
    type: "custom",
    customType: "session-activity-title",
    data: { version: 1, title: "修复侧栏标题" },
  }];
  const h = harness(async () => ({ action: "keep" }), entries);
  h.handlers.get("session_start")?.({}, h.ctx);
  assert.deepEqual(h.titles, ["修复侧栏标题"]);
});

test("a result from a shut down session cannot overwrite the next session", async () => {
  let resolveDecision: ((value: { action: "update"; title: string }) => void) | undefined;
  const classify: TitleClassifier = () => new Promise((resolve) => { resolveDecision = resolve; });
  const h = harness(classify);
  h.handlers.get("session_start")?.({}, h.ctx);
  h.handlers.get("input")?.({ text: "Old work", source: "interactive" }, h.ctx);
  await flush();
  h.handlers.get("session_shutdown")?.({}, h.ctx);
  resolveDecision?.({ action: "update", title: "Stale title" });
  await flush();
  assert.deepEqual(h.titles, []);
  assert.deepEqual(h.appended, []);
});

test("manual session rename invalidates an in-flight AI decision", async () => {
  let resolveDecision: ((value: { action: "update"; title: string }) => void) | undefined;
  const classify: TitleClassifier = () => new Promise((resolve) => { resolveDecision = resolve; });
  const h = harness(classify);
  h.handlers.get("session_start")?.({}, h.ctx);
  h.handlers.get("input")?.({ text: "Old work", source: "interactive" }, h.ctx);
  await flush();

  h.setSessionName("User Rename");
  h.handlers.get("session_info_changed")?.({ name: "User Rename" }, h.ctx);
  resolveDecision?.({ action: "update", title: "AI Title" });
  await flush();

  assert.equal(h.getSessionName(), "User Rename");
  assert.deepEqual(h.titles, ["User Rename"]);
  assert.deepEqual(h.appended, []);
});

test("session start aborts an in-flight BYOK request", async () => {
  let aborted = false;
  const classify: TitleClassifier = (_input, _title, _ctx, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true });
  });
  const h = harness(classify);
  h.handlers.get("session_start")?.({}, h.ctx);
  h.handlers.get("input")?.({ text: "Old work", source: "interactive" }, h.ctx);
  await flush();
  h.handlers.get("session_start")?.({}, h.ctx);
  await flush();
  assert.equal(aborted, true);
});

test("extension-generated inputs do not invoke the classifier", async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; return { action: "keep" }; });
  h.handlers.get("session_start")?.({}, h.ctx);
  h.handlers.get("input")?.({ text: "background follow-up", source: "extension" }, h.ctx);
  await flush();
  assert.equal(calls, 0);
});
