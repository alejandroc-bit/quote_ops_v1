import { describe, expect, it } from "vitest";
import { appendAuditEvent, createAuditEvent } from "../src/index";

describe("audit events", () => {
  it("creates stable audit events with version and node metadata", () => {
    const event = createAuditEvent({
      run_id: "RUN-1",
      node_id: "quoteCore",
      event_type: "node_completed",
      payload: { status: "APPROVED" }
    });

    expect(event.audit_version).toBe("audit-v2.0.0");
    expect(event.event_id).toMatch(/^evt_/);
    expect(event.node_id).toBe("quoteCore");
    expect(event.payload_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("appends events without mutating the previous timeline", () => {
    const timeline = [];
    const event = createAuditEvent({
      run_id: "RUN-1",
      node_id: "approvalGate",
      event_type: "review_required",
      payload: { reasons: ["route_evidence_missing"] }
    });

    const next = appendAuditEvent(timeline, event);

    expect(timeline).toHaveLength(0);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(event);
  });
});

