import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("cli bootstrap entrypoint", () => {
  it("runs without throwing and returns exit code 0", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = main();

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledOnce();

    logSpy.mockRestore();
  });
});
