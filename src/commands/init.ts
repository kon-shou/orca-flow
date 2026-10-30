import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, loadConfig } from "../config.ts";
import { detectRepo, isMainCheckout, type Detection } from "../lib/detect.ts";
import { repoRoot, type Runner } from "../lib/exec.ts";
import { FlowError, type Command, type CommandContext } from "../types.ts";

/** プラグインの templates/ */
export const TEMPLATES_DIR = fileURLToPath(
  new URL("../../templates/", import.meta.url),
);

/** setup.sh の雛形で、依存の導入の行を差し込む印 */
export const INSTALL_MARKER = "# orca-flow:install";

export const SETUP_COMMAND = "bash .orca-flow/setup.sh";

/** orca.yaml の setupAgentStartupPolicy：準備が終わってからエージェントを起動する */
export const SETUP_AGENT_STARTUP_POLICY = "wait-for-setup";

export const ORCA_YAML = `# Orca の設定。orca-flow が置いた
scripts:
  # 新しい worktree を作ったときの準備（.worktreeinclude のコピーと依存の導入）
  setup: ${SETUP_COMMAND}
# 準備が終わってからエージェントを起動する
setupAgentStartupPolicy: ${SETUP_AGENT_STARTUP_POLICY}
`;

export const PERMISSIONS = ["Bash(orca *)", "Bash(orca-flow *)"];

const ORCA_TIMEOUT_MS = 15_000;

/** 雛形の印の行を、検出した依存の導入の行に置き換える */
export function renderSetupScript(
  template: string,
  installLines: readonly string[],
): string {
  const lines = template.split("\n");
  const index = lines.findIndex((line) => line.trim() === INSTALL_MARKER);
  if (index < 0)
    throw new FlowError(
      1,
      `templates/setup.sh に印（${INSTALL_MARKER}）がありません`,
    );
  const replacement =
    installLines.length > 0
      ? [...installLines]
      : [
          "# 依存の導入：検出したものはありません。必要なら step で足してください",
        ];
  lines.splice(index, 1, ...replacement);
  return lines.join("\n");
}

type FileAction = "create" | "keep" | "no-template";

interface PlannedFile {
  path: string;
  action: FileAction;
  content?: string;
  mode?: number;
}

interface OrcaResult {
  registered: "already" | "added" | "failed" | "skipped";
  visibility: "already" | "set" | "failed" | "skipped";
  message?: string;
}

export interface InitData {
  yes: boolean;
  root: string;
  files: { path: string; action: FileAction }[];
  verify: string[];
  pathVerify: Detection["pathVerify"];
  sharedPaths: string[];
  readFirst: string[];
  installLines: string[];
  gitattributes: string[];
  orcaYamlToAdd: string | null;
  permissions: string[];
  orca: OrcaResult;
}

export const run: Command = async (ctx) => {
  const yes = ctx.argv.includes("--yes");
  const unknown = ctx.argv.filter((arg) => arg !== "--yes");
  if (unknown.length > 0)
    throw new FlowError(
      1,
      `init が知らない引数です：${unknown.join(" ")}（使えるのは --yes だけ）`,
    );

  const root = await repoRoot(ctx.runner, ctx.cwd);
  if (!root) throw new FlowError(2, "git のリポジトリの中で流してください");
  if ((await isMainCheckout(ctx.runner, root)) !== true)
    throw new FlowError(
      2,
      "init はメインのチェックアウト（統括役のタブ）で流してください",
    );

  const loaded = await loadConfig(root);
  const detection = await detectRepo(root, ctx.runner);
  const files = await planFiles(root, detection);
  const gitattributes = await missingGitattributes(
    root,
    loaded.config.appendOnlyFiles,
  );
  const orcaYamlPath = path.join(root, "orca.yaml");
  let orcaYamlToAdd: string | null = null;
  if (existsSync(orcaYamlPath)) {
    const text = await readFile(orcaYamlPath, "utf8");
    if (!text.includes(".orca-flow/setup.sh")) orcaYamlToAdd = ORCA_YAML;
  }

  let orca: OrcaResult = { registered: "skipped", visibility: "skipped" };
  if (yes) {
    await mkdir(path.join(root, ".orca-flow"), { recursive: true });
    for (const file of files) {
      if (file.action !== "create" || file.content === undefined) continue;
      const full = path.join(root, file.path);
      await writeFile(full, file.content, { flag: "wx" });
      if (file.mode !== undefined) await chmod(full, file.mode);
    }
    if (gitattributes.length > 0) {
      const full = path.join(root, ".gitattributes");
      const before = existsSync(full) ? await readFile(full, "utf8") : "";
      const sep = before === "" || before.endsWith("\n") ? "" : "\n";
      await writeFile(full, `${before}${sep}${gitattributes.join("\n")}\n`);
    }
    orca = await registerWithOrca(ctx.runner, root);
  }

  const data: InitData = {
    yes,
    root,
    files: files.map(({ path: file, action }) => ({ path: file, action })),
    verify: detection.verify,
    pathVerify: detection.pathVerify,
    sharedPaths: detection.sharedPaths,
    readFirst: detection.readFirst,
    installLines: detection.installLines,
    gitattributes,
    orcaYamlToAdd,
    permissions: PERMISSIONS,
    orca,
  };
  if (!ctx.json) report(ctx, data, detection);
  return { code: 0, data };
};

async function planFiles(
  root: string,
  detection: Detection,
): Promise<PlannedFile[]> {
  const planned: PlannedFile[] = [];
  const add = async (
    file: string,
    make: () => Promise<string | null>,
    mode?: number,
  ) => {
    if (existsSync(path.join(root, file))) {
      planned.push({ path: file, action: "keep" });
      return;
    }
    const content = await make();
    planned.push(
      content === null
        ? { path: file, action: "no-template" }
        : { path: file, action: "create", content, mode },
    );
  };

  await add(CONFIG_PATH, async () => {
    const template = JSON.parse(
      await readFile(path.join(TEMPLATES_DIR, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    const config = {
      ...template,
      readFirst: detection.readFirst,
      verify: detection.verify,
      pathVerify: detection.pathVerify,
      sharedPaths: detection.sharedPaths,
    };
    return `${JSON.stringify(config, null, 2)}\n`;
  });
  await add(
    ".orca-flow/setup.sh",
    async () =>
      renderSetupScript(
        await readFile(path.join(TEMPLATES_DIR, "setup.sh"), "utf8"),
        detection.installLines,
      ),
    0o755,
  );
  await add(".orca-flow/spec-template.md", async () => {
    const template = path.join(TEMPLATES_DIR, "spec-template.md");
    return existsSync(template) ? readFile(template, "utf8") : null;
  });
  await add("orca.yaml", async () => ORCA_YAML);
  return planned;
}

/** appendOnlyFiles のうち、.gitattributes に `〈パス〉 merge=union` がまだないものの行 */
async function missingGitattributes(
  root: string,
  appendOnlyFiles: readonly string[],
): Promise<string[]> {
  const full = path.join(root, ".gitattributes");
  const text = existsSync(full) ? await readFile(full, "utf8") : "";
  const present = new Set(
    text
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((words) => words.includes("merge=union"))
      .map((words) => words[0]),
  );
  const lines: string[] = [];
  for (const file of appendOnlyFiles) {
    if (present.has(file)) continue;
    present.add(file);
    lines.push(`${file} merge=union`);
  }
  return lines;
}

const real = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

function parseOrca(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    return typeof parsed.result === "object" && parsed.result !== null
      ? (parsed.result as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** ⑤ Orca にまだ登録していなければ登録し、Orca 以外の worktree も見せる設定にする */
async function registerWithOrca(
  runner: Runner,
  root: string,
): Promise<OrcaResult> {
  const fail = (message: string): OrcaResult => ({
    registered: "failed",
    visibility: "failed",
    message,
  });
  const list = await runner("orca", ["repo", "list", "--json"], {
    cwd: root,
    timeoutMs: ORCA_TIMEOUT_MS,
  });
  const listed =
    list.code === 0 && !list.timedOut ? parseOrca(list.stdout) : null;
  if (!listed || !Array.isArray(listed.repos))
    return fail("Orca につながりませんでした");
  const repo = (listed.repos as Record<string, unknown>[]).find(
    (item) => typeof item.path === "string" && real(item.path) === real(root),
  );

  const result: OrcaResult = { registered: "already", visibility: "already" };
  if (!repo) {
    const added = await runner(
      "orca",
      ["repo", "add", "--path", root, "--json"],
      { cwd: root, timeoutMs: ORCA_TIMEOUT_MS },
    );
    if (added.code !== 0 || added.timedOut)
      return fail(
        `orca repo add に失敗しました：${(added.stderr || added.stdout).trim()}`,
      );
    result.registered = "added";
  }
  if (repo?.externalWorktreeVisibility !== "show") {
    const set = await runner(
      "orca",
      [
        "repo",
        "set",
        "--repo",
        `path:${root}`,
        "--external-worktree-visibility",
        "show",
        "--json",
      ],
      { cwd: root, timeoutMs: ORCA_TIMEOUT_MS },
    );
    if (set.code !== 0 || set.timedOut) {
      result.visibility = "failed";
      result.message = `orca repo set に失敗しました：${(set.stderr || set.stdout).trim()}`;
    } else {
      result.visibility = "set";
    }
  }
  return result;
}

const ACTION_LABEL: Record<FileAction, string> = {
  create: "置く",
  keep: "すでにあるので書き換えない",
  "no-template": "プラグインに雛形がないので置かない",
};

function report(ctx: CommandContext, data: InitData, detection: Detection) {
  const lines: string[] = [];
  const list = (items: readonly string[]) =>
    items.length > 0 ? items.map((item) => `  - ${item}`) : ["  - なし"];

  lines.push(
    data.yes
      ? "orca-flow を入れました（コミットはしていません）"
      : "orca-flow init で置くもの（まだ何も書いていません。置くときは --yes をつけて流してください）",
  );
  lines.push("", "ファイル：");
  for (const file of data.files)
    lines.push(`  - ${file.path}：${ACTION_LABEL[file.action]}`);
  if (data.gitattributes.length > 0) {
    lines.push(
      `  - .gitattributes：次の行を${data.yes ? "足しました" : "足す"}`,
    );
    for (const line of data.gitattributes) lines.push(`      ${line}`);
  } else {
    lines.push(
      "  - .gitattributes：足す行はありません（appendOnlyFiles を config.json に書いたら、もう一度 init --yes で足せます）",
    );
  }
  if (data.orcaYamlToAdd) {
    lines.push(
      "",
      "orca.yaml はすでにあるので書き換えません。次を手で足してください：",
      ...data.orcaYamlToAdd
        .trimEnd()
        .split("\n")
        .map((line) => `    ${line}`),
    );
  }

  lines.push("", "検出したもの：");
  lines.push(
    `  - パッケージマネージャー：${detection.packageManager ?? "なし"}`,
    `  - ロックファイル：${detection.lockfiles.join("、") || "なし"}`,
    `  - pyproject.toml のある場所：${detection.pyprojectDirs.join("、") || "なし"}`,
    `  - .worktreeinclude：${detection.worktreeInclude ? "あり（setup.sh がメインからコピーする）" : "なし"}`,
    `  - CLAUDE.md：${detection.claudeMd ?? "なし"}`,
  );
  lines.push("", "verify（統合の前に流すコマンド）：", ...list(data.verify));
  lines.push(
    "",
    "pathVerify（差分がその場所にあるときだけ足す）：",
    ...list(
      data.pathVerify.map(
        (item) => `${item.paths.join("、")} → ${item.commands.join(" && ")}`,
      ),
    ),
  );
  lines.push("", "sharedPaths（共有のファイル）：", ...list(data.sharedPaths));
  lines.push("", "setup.sh の依存の導入：", ...list(data.installLines));
  lines.push(
    "",
    "人間と決めること：readFirst、progress（進捗表）、appendOnlyFiles（docs/decisions.md のような追記の表）、reviewerAgent、pathVerify、テンプレートに足す節",
  );
  lines.push(
    "",
    `.claude/settings.json の permissions.allow に足すとよい許可（orca-flow は書き換えません）：${data.permissions.join("、")}`,
  );

  if (data.yes) {
    lines.push("", "Orca：");
    const { orca } = data;
    if (orca.registered === "failed" && orca.visibility === "failed") {
      lines.push(
        `  - ${orca.message ?? "Orca に登録できませんでした"}。Orca を起動してから、次を流してください：`,
        `      orca repo add --path ${data.root}`,
        `      orca repo set --repo path:${data.root} --external-worktree-visibility show`,
      );
    } else {
      lines.push(
        `  - 登録：${orca.registered === "added" ? "登録しました" : "登録済み"}`,
        `  - Orca 以外の worktree の表示：${
          orca.visibility === "set"
            ? "show にしました"
            : orca.visibility === "already"
              ? "show 済み"
              : `変えられませんでした（${orca.message ?? ""}）`
        }`,
      );
    }
  } else {
    lines.push(
      "",
      "--yes をつけると、Orca にまだ登録していなければ登録し、Orca 以外の worktree も表示する設定にします",
    );
  }
  ctx.stdout(lines.join("\n"));
  if (data.yes && data.orca.registered === "failed")
    ctx.stderr(
      "orca-flow: Orca への登録はまだです（上の手順で行ってください）",
    );
}
