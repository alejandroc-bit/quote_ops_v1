import { describe, expect, it } from "vitest";
import {
  createCriteriaVersion,
  retrieveCriteria,
  validateCriteriaNode,
  type CriteriaNode
} from "../src/index";

const nodes: CriteriaNode[] = [
  {
    id: "criterion.sector.automotive.expedited",
    type: "sector_rule",
    title: "Automotriz urgente no se cotiza al piso",
    body: "Proteger disponibilidad y no igualar historico bajo.",
    priority: 85,
    phases: ["pricing_recommendation"],
    applies_when: {
      sector: ["automotriz"]
    },
    source: {
      kind: "director_input",
      owner_role: "direccion_operaciones",
      captured_at: "2026-06-16"
    }
  },
  {
    id: "criterion.approval.margin.low",
    type: "approval_rule",
    title: "Margen bajo requiere pricing manager",
    body: "Si el margen esta debajo del objetivo, detener para aprobacion.",
    priority: 100,
    phases: ["approval"],
    applies_when: {
      approval_risk: ["margin_below_target"]
    },
    source: {
      kind: "pricing_policy",
      owner_role: "pricing_manager",
      captured_at: "2026-06-16"
    }
  },
  {
    id: "criterion.communication.general",
    type: "communication_rule",
    title: "Respuesta comercial sobria",
    body: "No exponer costos internos en el correo al cliente.",
    priority: 60,
    phases: ["communication"],
    applies_when: {},
    source: {
      kind: "commercial_policy",
      owner_role: "direccion_comercial",
      captured_at: "2026-06-16"
    }
  }
];

describe("retrieveCriteria", () => {
  it("retrieves sector criteria for pricing recommendation", () => {
    const result = retrieveCriteria({
      criteria_version: "criteria-2026.06.16.1",
      client_id: "cliente-demo",
      phase: "pricing_recommendation",
      context: { sector: "automotriz" },
      nodes
    });

    expect(result.criteria_version).toBe("criteria-2026.06.16.1");
    expect(result.nodes.map((node) => node.id)).toEqual([
      "criterion.sector.automotive.expedited"
    ]);
  });

  it("retrieves approval rules for low margin", () => {
    const result = retrieveCriteria({
      criteria_version: "criteria-2026.06.16.1",
      client_id: "cliente-demo",
      phase: "approval",
      context: { approval_risk: "margin_below_target" },
      nodes
    });

    expect(result.nodes.map((node) => node.id)).toEqual([
      "criterion.approval.margin.low"
    ]);
  });

  it("excludes non-applicable nodes", () => {
    const result = retrieveCriteria({
      criteria_version: "criteria-2026.06.16.1",
      client_id: "cliente-demo",
      phase: "pricing_recommendation",
      context: { sector: "retail" },
      nodes
    });

    expect(result.nodes).toEqual([]);
  });

  it("preserves criteria version in result metadata", () => {
    expect(createCriteriaVersion("criteria", new Date("2026-06-16T00:00:00Z"), 1)).toBe(
      "criteria-2026.06.16.1"
    );
  });
});

describe("validateCriteriaNode", () => {
  it("rejects nodes with heavy operational payloads", () => {
    const heavyNode = {
      ...nodes[0],
      payload: {
        rows: Array.from({ length: 1001 }, (_, index) => ({
          quote_id: `Q-${index}`,
          rate_mxn: index
        }))
      }
    };

    expect(() => validateCriteriaNode(heavyNode)).toThrow();
  });
});

