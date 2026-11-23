import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
let requireManifestRepo: (dir: string) => void;
let updateManifestRepo: (
  dir: string,
  rel: string,
  content: string,
  opts?: { push?: boolean; msg?: string; stdio?: "inherit" | "pipe" },
) => "written" | "pushed" | "unchanged";

beforeAll(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs.
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    rubyString: typeof rubyString;
    renderFormula: typeof renderFormula;
    requireManifestRepo: typeof requireManifestRepo;
    updateManifestRepo: typeof updateManifestRepo;
  };
  rubyString = mod.rubyString;
  renderFormula = mod.renderFormula;
  requireManifestRepo = mod.requireManifestRepo;
  updateManifestRepo = mod.updateManifestRepo;
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
    const urlLine = formula.split("\n").find((l) => l.trimStart().startsWith("url ") && l.includes("system"));
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

// scripts/stage-release-asset.mjs is the step before update-manifests in the
// release chain, and it hashes whatever binary is on disk. It must refuse one
// whose --version is not package.json's, or a skipped rebuild ships an old
// binary under the new version. Run as a subprocess against a copy of the script
// in a scratch repo layout, so the real bin/ and dist-release/ are not touched.
// The "binary" is a copy of this Node, whose --version ("v22.x.y") the script
// parses like the real one's "caddy-mcp x.y.z".
describe("stage-release-asset refuses a stale binary", () => {
  const SLOW = 120_000;
  const stageScript = join(dirname(scriptPath), "stage-release-asset.mjs");
  const root = mkdtempSync(join(tmpdir(), "caddy-mcp-stage-"));
  const ext = process.platform === "win32" ? ".exe" : "";
  const asset = join(root, "dist-release", `caddy-mcp-${process.platform}-${process.arch}${ext}`);

  beforeAll(() => {
    mkdirSync(join(root, "scripts"));
    cpSync(stageScript, join(root, "scripts", "stage-release-asset.mjs"));
    const binDir = join(root, "bin", `${process.platform}-${process.arch}`);
    mkdirSync(binDir, { recursive: true });
    cpSync(process.execPath, join(binDir, `caddy-mcp${ext}`));
  }, SLOW);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stage(version: string): { status: number | null; stderr: string } {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@yawlabs/caddy-mcp", version, bin: { "caddy-mcp": "bin/caddy-mcp.mjs" } }),
    );
    const res = spawnSync(process.execPath, [join(root, "scripts", "stage-release-asset.mjs")], {
      encoding: "utf-8",
      env: { ...process.env, GITHUB_OUTPUT: "" },
      timeout: SLOW,
    });
    return { status: res.status, stderr: res.stderr };
  }

  it(
    "refuses, and stages nothing, when the binary reports another version",
    () => {
      const res = stage("0.0.1");
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`reports ${process.versions.node}, but package.json is 0.0.1`);
      expect(existsSync(asset)).toBe(false);
    },
    SLOW,
  );

  it(
    "stages the binary and its sha256 sidecar when the versions match",
    () => {
      const res = stage(process.versions.node);
      expect(res.status).toBe(0);
      expect(existsSync(asset)).toBe(true);
      expect(readFileSync(`${asset}.sha256`, "utf-8")).toMatch(/^[0-9a-f]{64} {2}caddy-mcp-/);
    },
    SLOW,
  );
});

// The write/commit/push half, against scratch repos in a temp dir: a bare
// "origin" plus clones of it, so nothing here reaches the network or the real
// scoop-yaw / homebrew-yaw checkouts.
describe("update-manifests updateManifestRepo", () => {
  const REL = "bucket/caddy-mcp.json";
  // Git is slow to spawn on Windows (seconds per call under load), and a push
  // run is five calls.
  const SLOW = 120_000;
  const tmp = mkdtempSync(join(tmpdir(), "caddy-mcp-manifests-"));
  const template = join(tmp, "template");
  const savedEnv: Record<string, string | undefined> = {};
  let n = 0;

  const git = (dir: string, ...a: string[]): string =>
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  beforeAll(() => {
    // The subject runs git with this process's environment, so the identity and
    // the isolation from the machine's own config (commit signing, autocrlf,
    // hooks) go in the environment rather than in each repo's config.
    const emptyConfig = join(tmp, "gitconfig");
    writeFileSync(emptyConfig, "");
    const env: Record<string, string> = {
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "update-manifests test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "update-manifests test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    for (const [k, v] of Object.entries(env)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    // One bare origin holding the manifest at v1 and one clone of it, built once
    // and copied per test. The remote is a RELATIVE path so a copy of the pair
    // points at its own origin, not the template's.
    const origin = join(template, "origin.git");
    const work = join(template, "work");
    mkdirSync(template);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });
    execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "pipe" });
    mkdirSync(join(work, "bucket"));
    writeFileSync(join(work, REL), "v1\n");
    git(work, "add", REL);
    git(work, "commit", "-q", "-m", "seed");
    git(work, "remote", "add", "origin", "../origin.git");
    git(work, "push", "-q", "origin", "main");
  }, SLOW);

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A fresh copy of the origin + clone pair. */
  function scratch(): { root: string; origin: string; work: string } {
    const root = join(tmp, `case-${++n}`);
    cpSync(template, root, { recursive: true });
    return { root, origin: join(root, "origin.git"), work: join(root, "work") };
  }

  const push = { push: true, msg: "caddy-mcp 2.0.0", stdio: "pipe" as const };

  it("refuses a manifest repo root that does not exist, and does not create it", () => {
    const missing = join(tmp, "no-such-scoop-yaw");
    expect(() => requireManifestRepo(missing)).toThrow("no such file or directory");
    expect(() => updateManifestRepo(missing, REL, "v2\n")).toThrow("no such file or directory");
    expect(existsSync(missing)).toBe(false);
  });

  it("refuses a manifest repo root that is a file", () => {
    const file = join(tmp, "a-file");
    writeFileSync(file, "");
    expect(() => requireManifestRepo(file)).toThrow("no such file or directory");
  });

  it("creates a missing subdirectory inside an existing checkout", () => {
    const root = join(tmp, "plain-dir");
    mkdirSync(root);
    expect(updateManifestRepo(root, "Formula/caddy-mcp.rb", "class CaddyMcp\n")).toBe("written");
    expect(readFileSync(join(root, "Formula", "caddy-mcp.rb"), "utf-8")).toBe("class CaddyMcp\n");
  });

  it(
    "pushes an update to a tracked manifest when origin has moved on, committing only the manifest",
    () => {
      // The original order wrote the manifest and THEN ran `git pull --rebase`,
      // which git refuses over a modified tracked file -- every bump after the
      // first died there.
      const { root, origin, work } = scratch();
      const other = join(root, "other");
      cpSync(work, other, { recursive: true });
      writeFileSync(join(other, "README.md"), "someone else's commit\n");
      git(other, "add", "README.md");
      git(other, "commit", "-q", "-m", "unrelated");
      git(other, "push", "-q", "origin", "main");
      // Unrelated staged work in the checkout must not ride along in the commit.
      writeFileSync(join(work, "notes.txt"), "in progress\n");
      git(work, "add", "notes.txt");

      expect(updateManifestRepo(work, REL, "v2\n", push)).toBe("pushed");
      expect(git(origin, "show", `main:${REL}`)).toBe("v2");
      expect(git(origin, "log", "--format=%s", "main").split("\n")).toEqual(["caddy-mcp 2.0.0", "unrelated", "seed"]);
      expect(git(origin, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual(["README.md", REL]);
      expect(git(work, "status", "--porcelain")).toBe("A  notes.txt");
    },
    SLOW,
  );

  it(
    "pushes after a run without --push left the manifest modified, then skips the commit on a re-run",
    () => {
      const { origin, work } = scratch();
      // Review-then-push: the first run leaves a modified tracked file behind.
      expect(updateManifestRepo(work, REL, "v2\n", { stdio: "pipe" })).toBe("written");
      expect(updateManifestRepo(work, REL, "v2\n", push)).toBe("pushed");
      expect(git(origin, "show", `main:${REL}`)).toBe("v2");
      // `git commit` exits 1 on "nothing to commit", which stopped a re-run after
      // a partial push at the first repo, before it reached the second.
      expect(updateManifestRepo(work, REL, "v2\n", push)).toBe("unchanged");
      expect(git(origin, "rev-list", "--count", "main")).toBe("2");
      expect(git(work, "stash", "list")).toBe("");
    },
    SLOW,
  );

  /** Another clone commits the manifest itself at `content` and pushes it. */
  function pushManifestFromElsewhere(root: string, work: string, content: string): void {
    const other = join(root, "other");
    cpSync(work, other, { recursive: true });
    // `work` may be dirty (the second case below); the other clone starts clean.
    git(other, "checkout", "--", ".");
    writeFileSync(join(other, REL), content);
    git(other, "add", REL);
    git(other, "commit", "-q", "-m", "manifest from elsewhere");
    git(other, "push", "-q", "origin", "main");
  }

  // The cases above only move README.md on origin, so they pass with the pull
  // after the write as well: a rebase over a change to ANOTHER file never meets
  // the modified manifest. These move the manifest itself, which is the case
  // the pull-before-write order exists for.
  it(
    "overwrites a manifest another clone changed and pushed, leaving no stash behind",
    () => {
      const { root, origin, work } = scratch();
      pushManifestFromElsewhere(root, work, "v1.5\n");
      expect(updateManifestRepo(work, REL, "v2\n", push)).toBe("pushed");
      expect(git(origin, "show", `main:${REL}`)).toBe("v2");
      expect(git(work, "stash", "list")).toBe("");
      expect(git(work, "status", "--porcelain")).toBe("");
    },
    SLOW,
  );

  it(
    "overwrites a manifest another clone changed and pushed after a run without --push left it modified",
    () => {
      const { root, origin, work } = scratch();
      expect(updateManifestRepo(work, REL, "v2\n", { stdio: "pipe" })).toBe("written");
      pushManifestFromElsewhere(root, work, "v1.5\n");
      expect(updateManifestRepo(work, REL, "v2\n", push)).toBe("pushed");
      expect(git(origin, "show", `main:${REL}`)).toBe("v2");
      expect(git(work, "stash", "list")).toBe("");
      expect(git(work, "status", "--porcelain")).toBe("");
    },
    SLOW,
  );

  it(
    "pushes a commit an earlier run made but never pushed",
    () => {
      const { origin, work } = scratch();
      writeFileSync(join(work, REL), "v2\n");
      git(work, "commit", "-q", "-m", "caddy-mcp 2.0.0", "--", REL);
      expect(updateManifestRepo(work, REL, "v2\n", push)).toBe("unchanged");
      expect(git(origin, "show", `main:${REL}`)).toBe("v2");
    },
    SLOW,
  );
});
