import { describe, it, expect } from "vitest";
import { classifyError } from "./errorClassify";

describe("classifyError", () => {
  it("cli-missing via 'command not found' in stderr", () => {
    expect(
      classifyError({
        error: null,
        stderr: ["sh: claude: command not found"],
      })
    ).toEqual({
      kind: "cli-missing",
      message: "找不到 claude CLI。请确认已安装并在 PATH 中。",
    });
  });

  it("cli-missing via exitCode 127", () => {
    expect(
      classifyError({
        error: null,
        stderr: [],
        exitCode: 127,
      })
    ).toEqual({
      kind: "cli-missing",
      message: "找不到 claude CLI。请确认已安装并在 PATH 中。",
    });
  });

  it("permission via 'EACCES'", () => {
    expect(
      classifyError({
        error: "spawn EACCES",
        stderr: [],
      })
    ).toEqual({
      kind: "permission",
      message: "权限被拒绝。可在配置里切换 Permission Mode 后重试。",
    });
  });

  it("rate-limit via '429'", () => {
    expect(
      classifyError({
        error: null,
        stderr: ["HTTP 429 too many requests"],
      })
    ).toEqual({
      kind: "rate-limit",
      message: "触发了模型/账号限流，请稍等后重试。",
    });
  });

  it("crashed via exitCode 1", () => {
    expect(
      classifyError({
        error: null,
        stderr: [],
        exitCode: 1,
      })
    ).toEqual({
      kind: "crashed",
      message: "Claude CLI 异常退出（exit 1）。",
    });
  });

  it("unknown when stderr has unrelated noise", () => {
    expect(
      classifyError({
        error: null,
        stderr: ["something odd happened"],
      })
    ).toEqual({
      kind: "unknown",
      message: "出错了。",
    });
  });

  it("returns null when error is null, stderr is [], exitCode is 0", () => {
    expect(
      classifyError({
        error: null,
        stderr: [],
        exitCode: 0,
      })
    ).toBeNull();
  });

  it("priority: cli-missing wins over a generic non-zero exit code", () => {
    expect(
      classifyError({
        error: null,
        stderr: ["No such file or directory"],
        exitCode: 1,
      })
    ).toEqual({
      kind: "cli-missing",
      message: "找不到 claude CLI。请确认已安装并在 PATH 中。",
    });
  });
});
