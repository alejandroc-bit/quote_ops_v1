import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  startMailboxIntake: vi.fn(),
  error: vi.fn()
}));

vi.mock("node:http", () => ({
  createServer: vi.fn(() => ({ listen: mocks.listen }))
}));

vi.mock("../src/sentinel/index.js", () => ({
  startSentinel: vi.fn()
}));

vi.mock("../src/intake/mailboxPoller.js", () => ({
  startMailboxIntake: mocks.startMailboxIntake
}));

describe("agent server mailbox intake startup", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.listen.mockReset();
    mocks.startMailboxIntake.mockReset();
    mocks.startMailboxIntake.mockResolvedValue(null);
    mocks.error.mockReset();
  });

  it("starts the configured mailbox intake when the production agent process starts", async () => {
    await import("../src/server.js");

    expect(mocks.startMailboxIntake).toHaveBeenCalledWith(process.env);
  });

  it("reports mailbox startup rejection without an unhandled rejection", async () => {
    mocks.startMailboxIntake.mockRejectedValueOnce(new Error("fixture-mailbox-secret"));
    const error = vi.spyOn(console, "error").mockImplementation(mocks.error);

    await import("../src/server.js");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(mocks.error).toHaveBeenCalledWith(
      "[mailbox-intake] failed to start safely; intake remains disabled"
    );
    expect(mocks.error.mock.calls.flat().join(" ")).not.toContain("fixture-mailbox-secret");
    error.mockRestore();
  });
});
