export type ErrorKind =
  | "cli-missing"
  | "permission"
  | "rate-limit"
  | "crashed"
  | "unknown";

export type ClassifiedError = { kind: ErrorKind; message: string };

const CLI_MISSING_NEEDLES = [
  "command not found",
  "no such file or directory",
  "claude: not found",
];
const PERMISSION_NEEDLES = [
  "eacces",
  "permission denied",
  "--dangerously-skip-permissions",
  "not allowed",
];
const RATE_LIMIT_NEEDLES = [
  "rate limit",
  "429",
  "quota",
  "usage limit reached",
];
const CRASH_NEEDLES = ["panicked at", "signal", "killed"];

function hasMatch(texts: string[], needles: string[]) {
  return needles.some((needle) =>
    texts.some((text) => text.toLowerCase().includes(needle))
  );
}

export function classifyError(input: {
  error: string | null;
  stderr: string[];
  exitCode?: number;
}): ClassifiedError | null {
  const error = input.error?.trim() ?? "";
  const stderr = input.stderr.map((line) => line.trim()).filter(Boolean);
  const exitCode = input.exitCode;

  if (!error && stderr.length === 0 && (exitCode === 0 || exitCode === undefined)) {
    return null;
  }

  const haystack = error ? [error, ...stderr] : stderr;

  if (exitCode === 127 || hasMatch(haystack, CLI_MISSING_NEEDLES)) {
    return {
      kind: "cli-missing",
      message: "找不到 claude CLI。请确认已安装并在 PATH 中。",
    };
  }

  if (hasMatch(haystack, PERMISSION_NEEDLES)) {
    return {
      kind: "permission",
      message: "权限被拒绝。可在配置里切换 Permission Mode 后重试。",
    };
  }

  if (hasMatch(haystack, RATE_LIMIT_NEEDLES)) {
    return {
      kind: "rate-limit",
      message: "触发了模型/账号限流，请稍等后重试。",
    };
  }

  if ((exitCode !== undefined && exitCode !== 0) || hasMatch(stderr, CRASH_NEEDLES)) {
    return {
      kind: "crashed",
      message: `Claude CLI 异常退出（exit ${exitCode ?? "?"}）。`,
    };
  }

  return {
    kind: "unknown",
    message: "出错了。",
  };
}
