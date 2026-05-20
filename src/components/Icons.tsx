import type { CSSProperties } from "react";

type Props = { size?: number; style?: CSSProperties; className?: string };

const base = (size = 16): CSSProperties => ({
  width: size,
  height: size,
  display: "inline-block",
  verticalAlign: "middle",
});

export function NewChatIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <path d="M4 5h11M4 10h7M4 15h5" />
      <path d="M14.5 14.5l5 5M19.5 14.5l-5 5" opacity="0" />
      <path d="M16 4l4 4-9 9H7v-4l9-9z" />
    </svg>
  );
}

export function SearchIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

export function PluginIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <path d="M9 3v3H6a2 2 0 0 0-2 2v3h3a2 2 0 1 1 0 4H4v3a2 2 0 0 0 2 2h3v-3a2 2 0 1 1 4 0v3h3a2 2 0 0 0 2-2v-3h-3a2 2 0 1 1 0-4h3V8a2 2 0 0 0-2-2h-3V3" />
    </svg>
  );
}

export function ClockIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function FolderIcon({ size = 16, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
    </svg>
  );
}

export function GearIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09c0 .67.39 1.27 1 1.51a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82c.24.61.84 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.67 0-1.27.39-1.51 1z" />
    </svg>
  );
}

export function TerminalIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  );
}

export function InfoIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

export function PlusIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MicIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

export function SendIcon({ size = 16, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function ChevronDown({ size = 14, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function ChevronRight({ size = 14, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function WarningDot({ size = 14, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="14"
        fontWeight="bold"
        fill="white"
      >
        !
      </text>
    </svg>
  );
}

export function AutomationIcon({ size = 18, style, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ ...base(size), ...style }}
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
