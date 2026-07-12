import { describe, expect, it } from "vitest";
import { consumeMaskedInput } from "../src/onboard/tronUi.js";

describe("consumeMaskedInput", () => {
  it("accepts a pasted burst that includes the trailing enter", () => {
    const result = consumeMaskedInput("", "nvapi-secret123\r");
    expect(result).toEqual({ value: "nvapi-secret123", done: true });
  });

  it("accumulates char-by-char typing until enter", () => {
    let state = { value: "", done: false };
    for (const ch of ["a", "b", "c"]) state = consumeMaskedInput(state.value, ch);
    expect(state).toEqual({ value: "abc", done: false });
    expect(consumeMaskedInput(state.value, "\n")).toEqual({ value: "abc", done: true });
  });

  it("applies backspace inside a burst", () => {
    expect(consumeMaskedInput("", "abcde\r")).toEqual({ value: "abce", done: true });
  });
});
