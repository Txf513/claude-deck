import { describe, expect, it } from "vitest";
import {
  applyMcpServers,
  parseMcpServers,
  type McpServer,
} from "./config";

describe("mcpServers config helpers", () => {
  it("parse empty object returns no servers or invalid entries", () => {
    expect(parseMcpServers("{}")).toEqual({
      servers: [],
      invalid: [],
    });
  });

  it("parses a stdio entry with args and env", () => {
    expect(
      parseMcpServers(`{
  "mcpServers": {
    "myStdio": {
      "command": "/path/to/bin",
      "args": ["--flag", "x"],
      "env": {
        "FOO": "bar"
      }
    }
  }
}`)
    ).toEqual({
      servers: [
        {
          name: "myStdio",
          transport: "stdio",
          command: "/path/to/bin",
          args: ["--flag", "x"],
          env: { FOO: "bar" },
        },
      ],
      invalid: [],
    });
  });

  it("parses an http entry", () => {
    expect(
      parseMcpServers(`{
  "mcpServers": {
    "myHttp": {
      "type": "http",
      "url": "https://mcp.example.com",
      "headers": {
        "Authorization": "Bearer xyz"
      }
    }
  }
}`)
    ).toEqual({
      servers: [
        {
          name: "myHttp",
          transport: "http",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer xyz" },
        },
      ],
      invalid: [],
    });
  });

  it("parses an sse entry without headers", () => {
    expect(
      parseMcpServers(`{
  "mcpServers": {
    "mySse": {
      "type": "sse",
      "url": "https://sse.example.com"
    }
  }
}`)
    ).toEqual({
      servers: [
        {
          name: "mySse",
          transport: "sse",
          url: "https://sse.example.com",
          headers: {},
        },
      ],
      invalid: [],
    });
  });

  it("apply preserves unrelated top-level keys and omits empty mcpServers", () => {
    const input = `{
  "model": "sonnet",
  "hooks": {
    "onStart": "echo hi"
  },
  "mcpServers": {
    "old": {
      "command": "/tmp/old"
    }
  },
  "env": {
    "HELLO": "world"
  }
}
`;

    expect(applyMcpServers(input, [])).toBe(`{
  "model": "sonnet",
  "hooks": {
    "onStart": "echo hi"
  },
  "env": {
    "HELLO": "world"
  }
}
`);
  });

  it("roundtrips parse -> apply -> parse with semantic equality", () => {
    const servers: McpServer[] = [
      {
        name: "stdioOne",
        transport: "stdio",
        command: "/usr/bin/mcp-one",
        args: [],
        env: {},
      },
      {
        name: "httpOne",
        transport: "http",
        url: "https://mcp.example.com",
        headers: {},
      },
      {
        name: "sseOne",
        transport: "sse",
        url: "https://sse.example.com",
        headers: {
          Authorization: "Bearer xyz",
        },
      },
    ];

    const reapplied = applyMcpServers(
      `{
  "model": "sonnet"
}
`,
      parseMcpServers(applyMcpServers("{}", servers)).servers
    );

    expect(parseMcpServers(reapplied)).toEqual({
      servers,
      invalid: [],
    });
  });

  it("surfaces invalid entries and throws on invalid settings JSON during apply", () => {
    expect(
      parseMcpServers(`{
  "mcpServers": {
    "broken": {
      "type": "stdio"
    }
  }
}`)
    ).toEqual({
      servers: [],
      invalid: [
        {
          name: "broken",
          raw: { type: "stdio" },
        },
      ],
    });

    expect(() => applyMcpServers("{", [])).toThrow(
      "settings.json is not valid JSON"
    );
  });

  it("apply treats empty/whitespace settings.json as {}", () => {
    const server: McpServer = {
      name: "first",
      transport: "stdio",
      command: "/bin/first",
      args: [],
      env: {},
    };

    for (const empty of ["", "   \n  "]) {
      const out = applyMcpServers(empty, [server]);
      expect(parseMcpServers(out)).toEqual({
        servers: [server],
        invalid: [],
      });
    }

    expect(applyMcpServers("", [])).toBe(`{}\n`);
  });
});
