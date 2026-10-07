import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// scripts/update-manifests.mjs writes package.json's description into a Ruby
// double-quoted string in the Homebrew formula. These tests pin the escaping
// that keeps that value a plain string (CodeQL js/incomplete-sanitization).
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "update-manifests.mjs");

type FormulaAsset = { url: string; sha256: string };
type FormulaInput = {
  className: string;
  cmd: string;
  description: unknown;
  homepage: unknown;
  version: unknown;
  license: unknown;
  proprietary: boolean;
  assets: { macArm64: FormulaAsset; macX64: FormulaAsset; linuxX64: FormulaAsset };
};

let rubyString: (value: unknown) => string;
let renderFormula: (input: FormulaInput) => string;

beforeAll(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs.
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    rubyString: typeof rubyString;
    renderFormula: typeof renderFormula;
  };
  rubyString = mod.rubyString;
  renderFormula = mod.renderFormula;
});

// Read the body of a Ruby double-quoted literal the way Ruby does, failing on
// anything that would end the string early or interpolate code.
function parseRubyDq(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[++i];
      if (next === undefined) throw new Error("dangling backslash escapes the closing quote");
      out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    } else if (c === '"') {
      throw new Error(`unescaped quote at ${i} ends the string early`);
    } else if (c === "#" && /[{@$]/.test(body[i + 1] ?? "")) {
      throw new Error(`unescaped interpolation at ${i}`);
    } else if (c === "\n" || c === "\r") {
      throw new Error(`raw line break at ${i}`);
    } else {
      out += c;
    }
  }
  return out;
}

describe("update-manifests rubyString", () => {
  const cases = [
    "Caddy MCP server for Claude Code, Cursor, and any MCP client: admin API, config, routes",
    'He said "hi"',
    "trailing backslash \\",
    'backslash then quote \\"',
    "C:\\path\\to\\thing",
    '#{system("rm -rf ~")}',
    "#@ivar and #$global",
    "line one\nline two\r\n",
    "issue #12, C# and a trailing #",
    "\\#{already escaped}",
    "##{double}",
    "",
  ];

  for (const input of cases) {
    it(`round-trips ${JSON.stringify(input)}`, () => {
      expect(parseRubyDq(rubyString(input))).toBe(input);
    });
  }

  it("escapes the backslash before the quote", () => {
    // The old `.replace(/"/g, '\\"')` turned `\"` into `\\"`, which Ruby reads
    // as an escaped backslash followed by a closing quote.
    expect(rubyString('a\\"b')).toBe('a\\\\\\"b');
  });

  it("leaves a plain # unescaped", () => {
    expect(rubyString("issue #12, C# and a trailing #")).toBe("issue #12, C# and a trailing #");
    expect(rubyString("#{x} #y")).toBe("\\#{x} #y");
  });

  it("treats null and undefined as empty", () => {
    expect(rubyString(undefined)).toBe("");
    expect(rubyString(null)).toBe("");
  });
});

describe("update-manifests renderFormula", () => {
  const asset = (name: string): FormulaAsset => ({
    url: `https://github.com/YawLabs/caddy-mcp/releases/download/v1.2.3/${name}`,
    sha256: "0".repeat(64),
  });
  const base: FormulaInput = {
    className: "CaddyMcp",
    cmd: "caddy-mcp",
    description: "Caddy MCP server",
    homepage: "https://yaw.sh/mcp-servers/caddy-mcp/",
    version: "1.2.3",
    license: "MIT",
    proprietary: false,
    assets: {
      macArm64: asset("caddy-mcp-darwin-arm64"),
      macX64: asset("caddy-mcp-darwin-x64"),
      linuxX64: asset("caddy-mcp-linux-x64"),
    },
  };

  // The body of a one-line `<name> "..."` stanza in the rendered formula.
  function stanza(formula: string, name: string): string {
    const prefix = `  ${name} "`;
    const lines = formula.split("\n").filter((l) => l.startsWith(prefix));
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.endsWith('"')).toBe(true);
    return line.slice(prefix.length, -1);
  }

  it("escapes a hostile description into one plain desc line", () => {
    const hostile = 'Caddy" ; system("touch /tmp/pwned") ; "#{`id`} #@ivar #$0 \\"\nend\nclass Evil < Formula\n';
    const formula = renderFormula({ ...base, description: hostile });
    expect(parseRubyDq(stanza(formula, "desc"))).toBe(hostile);
    expect(formula.split("\n")[0]).toBe("class CaddyMcp < Formula");
    expect(formula).not.toMatch(/^class Evil/m);
    expect(formula).not.toMatch(/^end$\n^class/m);
  });

  it("escapes homepage, version and license the same way", () => {
    const formula = renderFormula({ ...base, homepage: 'https://x/"#{y}', version: '1"#{v}', license: 'MIT"#@l' });
    expect(parseRubyDq(stanza(formula, "homepage"))).toBe('https://x/"#{y}');
    expect(parseRubyDq(stanza(formula, "version"))).toBe('1"#{v}');
    expect(parseRubyDq(stanza(formula, "license"))).toBe('MIT"#@l');
  });

  it("escapes the urls and sha256s, which carry the --version tag and downloaded sidecar text", () => {
    const hostileUrl = 'https://x/v1"#{system("id")}/caddy-mcp-darwin-arm64';
    const hostileSha = '00"\nend\nclass Evil < Formula\n#{`id`}';
    const formula = renderFormula({
      ...base,
      assets: { ...base.assets, macArm64: { url: hostileUrl, sha256: hostileSha } },
    });
    const urlLine = formula.split("\n").find((l) => l.trimStart().startsWith("url ") && l.includes("v1"));
    expect(
      parseRubyDq(
        urlLine
          ?.trim()
          .replace(/^url "/, "")
          .replace(/", using: :nounzip$/, "") ?? "",
      ),
    ).toBe(hostileUrl);
    const shaLine = formula.split("\n").find((l) => l.trimStart().startsWith("sha256 ") && !l.includes('"0000'));
    expect(
      parseRubyDq(
        shaLine
          ?.trim()
          .replace(/^sha256 "/, "")
          .replace(/"$/, "") ?? "",
      ),
    ).toBe(hostileSha);
    expect(formula).not.toMatch(/^class Evil/m);
  });

  it("escapes the command name in bin.install and the test block", () => {
    const formula = renderFormula({ ...base, cmd: 'caddy"#{x}' });
    expect(formula).toContain('bin.install Dir["*"].first => "caddy\\"\\#{x}"');
    expect(formula).toContain('shell_output("#{bin}/caddy\\"\\#{x} --version")');
  });

  it.each([
    ["caddyMcp"],
    ["2fa"],
    ["Foo.Bar"],
    ["Evil < Object; end; class X"],
    [""],
  ])("refuses %j as a class name", (className) => {
    expect(() => renderFormula({ ...base, className })).toThrow("class name");
  });

  it("writes license :cannot_represent for a proprietary package", () => {
    const formula = renderFormula({ ...base, license: "UNLICENSED", proprietary: true });
    expect(formula).toContain("\n  license :cannot_represent\n");
  });

  it("keeps the formula's own interpolation in the test block", () => {
    expect(renderFormula(base)).toContain('shell_output("#{bin}/caddy-mcp --version")');
  });
});
