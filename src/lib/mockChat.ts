export type MockMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  processedSeconds?: number;
};

export type MockConversation = {
  id: string;
  title: string;
  shortcut?: string;
  ageLabel?: string;
  hasSchedule?: boolean;
  messages: MockMessage[];
};

export type MockProject = {
  id: string;
  name: string;
  conversations: MockConversation[];
  defaultOpen?: boolean;
};

export const mockProjects: MockProject[] = [
  {
    id: "zhongrui_system",
    name: "zhongrui_system",
    conversations: [
      {
        id: "z1",
        title: "Codex Companion Task: 调...",
        shortcut: "⌘1",
        messages: [],
      },
    ],
  },
  {
    id: "quant-system",
    name: "quant-system",
    conversations: [
      { id: "q1", title: "记录多因子调仓", shortcut: "⌘2", messages: [] },
      { id: "q2", title: "选A股尾盘标的", shortcut: "⌘3", messages: [] },
      { id: "q3", title: "生成A股短线选股提示词", shortcut: "⌘4", messages: [] },
      { id: "q4", title: "分析持仓分配", shortcut: "⌘5", messages: [] },
      { id: "q5", title: "判断是否补仓至15000", shortcut: "⌘6", messages: [] },
    ],
  },
  {
    id: "tech-notes",
    name: "tech-notes",
    conversations: [
      { id: "t1", title: "统计学习计划天数", shortcut: "⌘7", messages: [] },
    ],
  },
  {
    id: "AI-Advisors",
    name: "AI-Advisors",
    defaultOpen: true,
    conversations: [
      {
        id: "a1",
        title: "选择鱼钩套装",
        shortcut: "⌘8",
        messages: [
          {
            id: "m1",
            role: "user",
            content: "可以",
          },
          {
            id: "m2",
            role: "assistant",
            processedSeconds: 27,
            content: `直接买这套就行，按"孩子好上手、少折腾、安全一点"来配:

- **普通浮漂成品线组**: 买 1号或2号漂, 直接选 2.1米短竿通用 的那种
- **无倒刺金袖3号成品子线**: 2包
- **无倒刺金袖4号成品子线**: 1包
- **取钩器**: 1个
- **铅皮**: 1小卷
- **抄网**: 先不用买, 小鱼场景基本没必要
- **七星漂**: 先别买, 后面真去浅水草边玩再补

你下单时直接搜这几个关键词, 最省心:

- 2.1米短竿 成品线组 普通浮漂 1号
- 无倒刺金袖3号 成品子线
- 无倒刺金袖4号 成品子线
- 摘钩器 取钩器

如果你想再简单一点, 核心其实就 3 样:

- 普通浮漂成品线组
- 无倒刺金袖3号/4号
- 取钩器

不建议买的:

- 伊势尼大号钩
- 带倒刺鱼钩
- 特别花哨的进口套线大套装`,
          },
        ],
      },
      {
        id: "a2",
        title: "每日AI编程效率情报",
        shortcut: "⌘9",
        hasSchedule: true,
        messages: [],
      },
      {
        id: "a3",
        title: "Java程序员职业与AI转型...",
        ageLabel: "1 小时",
        hasSchedule: true,
        messages: [],
      },
      {
        id: "a4",
        title: "KAT6B 治疗进展每日检索",
        ageLabel: "1 小时",
        hasSchedule: true,
        messages: [],
      },
      {
        id: "a5",
        title: "推荐 ClaudeCode 可视化面板",
        ageLabel: "10 小时",
        messages: [],
      },
    ],
  },
];

export const mockTopActions = [
  { id: "new", label: "新对话", icon: "new" as const },
  { id: "search", label: "搜索", icon: "search" as const },
  { id: "plugin", label: "插件", icon: "plugin" as const },
  { id: "automation", label: "自动化", icon: "automation" as const, badge: 4 },
  { id: "mobile", label: "设置 Codex 移动版", icon: "mobile" as const },
];
