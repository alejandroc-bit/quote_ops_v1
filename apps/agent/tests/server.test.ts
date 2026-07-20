import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  startMailboxIntake: vi.fn()
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
  });

  it("does not start mailbox intake because the API process owns the licensed graph runtime", async () => {
    await import("../src/server.js");

    expect(mocks.startMailboxIntake).not.toHaveBeenCalled();
  });
});
