import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, loadConfig } from "../config.ts";
import { detectRepo, isMainCheckout, type Detection } from "../lib/detect.ts";
import { repoRoot, type Runner } from "../lib/exec.ts";
import { gitCommonDir, mainWorktreePath } from "../lib/git.ts";
import {
  checkOrcaHooks,
  hooksFixLines,
  HOOK_SETUP_LINE,
  type HooksCheck,
} from "../lib/orca-hooks.ts";
import { fromWslUncPath } from "../lib/paths.ts";
import { installWatchAutomation } from "../lib/watch-automation.ts";
import { ASK_PERMISSIONS } from "../lib/workspace-setup.ts";
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

/** setup.sh の雛形で、git に追跡されていない orca-flow のファイルをコピーする段の見出し（init はこれで段ありと見分ける） */
export const UNTRACKED_STAGE_HEADING =
  "# 2b. git で追跡していない orca-flow のファイルを";

export const PERMISSIONS = ["Bash(orca *)", "Bash(orca-flow *)"];

/** 置き場は workspace-setup.ts（lib から commands を import しないため）。名前はここからも出す */
export { ASK_PERMISSIONS };

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

/** 見張りの automation（taskEnd が "pr" のときだけ作る） */
interface WatchResult {
  status: "created" | "updated" | "failed" | "skipped";
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
  gitignore: string[];
  trackedRecords: string[];
  orcaYamlToAdd: string | null;
  permissions: string[];
  askPermissions: string[];
  orca: OrcaResult;
  watch: WatchResult;
  /** 以下は untracked のときだけ入る */
  untracked?: boolean;
  /** .git/info/exclude に足す（足した）行 */
  exclude?: string[];
  /** .git/info/attributes に足す（足した）行 */
  infoAttributes?: string[];
  /** すでに git が追跡している orca-flow のファイル */
  trackedFlowFiles?: string[];
  /** すでに追跡側のファイルへ足されている orca-flow の行（「ファイル：行」） */
  trackedFlowLines?: string[];
  /** 追跡をやめる手順の文 */
  untrackSteps?: string[];
  /** config.json に untracked のキーを足した（足す）か */
  untrackedKeyAdded?: boolean;
  /** setup.sh に 2b の段があるか（なければ作り直しの案内） */
  setupStage?: "present" | "missing" | "new";
  /** 画面のワークツリーフックの確かめ */
  hooks?: HooksCheck;
}

export const run: Command = async (ctx) => {
  const yes = ctx.argv.includes("--yes");
  const untrackedFlag = ctx.argv.includes("--untracked");
  const unknown = ctx.argv.filter(
    (arg) => arg !== "--yes" && arg !== "--untracked",
  );
  if (unknown.length > 0)
    throw new FlowError(
      1,
      `init が知らない引数です：${unknown.join(" ")}（使えるのは --yes と --untracked だけ）`,
    );

  const root = await repoRoot(ctx.runner, ctx.cwd);
  if (!root) throw new FlowError(2, "git のリポジトリの中で流してください");
  if ((await isMainCheckout(ctx.runner, root)) !== true)
    throw new FlowError(
      2,
      "init はメインのチェックアウト（統括役のタブ）で流してください",
    );

  const loaded = await loadConfig(root);
  const untracked = untrackedFlag || loaded.config.untracked;
  if (untracked) return runUntracked(ctx, root, loaded.config, yes);
  const detection = await detectRepo(root, ctx.runner);
  const files = await planFiles(root, detection);
  const gitattributes = await missingGitattributes(
    root,
    loaded.config.appendOnlyFiles,
  );
  const gitignore = await missingGitignore(ctx.runner, root, loaded.config);
  const trackedRecords = await trackedRecordFiles(
    ctx.runner,
    root,
    loaded.config,
  );
  const orcaYamlPath = path.join(root, "orca.yaml");
  let orcaYamlToAdd: string | null = null;
  if (existsSync(orcaYamlPath)) {
    const text = await readFile(orcaYamlPath, "utf8");
    if (!text.includes(".orca-flow/setup.sh")) orcaYamlToAdd = ORCA_YAML;
  }

  let orca: OrcaResult = { registered: "skipped", visibility: "skipped" };
  let watch: WatchResult = { status: "skipped" };
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
    if (gitignore.length > 0) {
      const full = path.join(root, ".gitignore");
      const before = existsSync(full) ? await readFile(full, "utf8") : "";
      const sep = before === "" || before.endsWith("\n") ? "" : "\n";
      await writeFile(full, `${before}${sep}${gitignore.join("\n")}\n`);
    }
    orca = await registerWithOrca(ctx.runner, root);
    if (loaded.config.taskEnd === "pr") {
      try {
        const done = await installWatchAutomation(ctx.runner, {
          root: await mainWorktreePath(ctx.runner, root),
          intervalMinutes: loaded.config.prWatch.intervalMinutes,
        });
        watch = { status: done.action };
      } catch (error) {
        watch = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
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
    gitignore,
    trackedRecords,
    orcaYamlToAdd,
    permissions: PERMISSIONS,
    askPermissions: ASK_PERMISSIONS,
    orca,
    watch,
  };
  if (!ctx.json) report(ctx, data, detection);
  return { code: 0, data };
};

async function planFiles(
  root: string,
  detection: Detection,
  untracked = false,
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
      ...(untracked ? { untracked: true } : {}),
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
  if (!untracked) await add("orca.yaml", async () => ORCA_YAML);
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

/** 設定のパスを、リポジトリの根からの形（先頭の ./ と末尾の / を除く）にする */
function cleanPath(file: string): string {
  return path.posix.normalize(file.replaceAll("\\", "/")).replace(/\/+$/, "");
}

/**
 * タスクの記録（tasksDir、tasksDir の外の reportsDir、progress.file）のうち、
 * git がまだ無視していないものの .gitignore の行。
 * ディレクトリは中の仮のファイル名で確かめる。追跡中のファイルがあっても、行がなければ足す。
 */
async function missingGitignore(
  runner: Runner,
  root: string,
  config: RecordPlaces,
): Promise<string[]> {
  return missingLines(runner, root, recordTargets(config));
}

interface RecordPlaces {
  tasksDir: string;
  reportsDir: string;
  progress: { file: string } | null;
}

interface IgnoreTarget {
  line: string;
  probe: string;
}

function recordTargets(config: RecordPlaces): IgnoreTarget[] {
  const tasksDir = cleanPath(config.tasksDir);
  const reportsDir = cleanPath(config.reportsDir);
  const targets: IgnoreTarget[] = [];
  const addDir = (dir: string) =>
    targets.push({ line: `/${dir}/`, probe: `${dir}/orca-flow-probe` });
  addDir(tasksDir);
  if (reportsDir !== tasksDir && !reportsDir.startsWith(`${tasksDir}/`))
    addDir(reportsDir);
  if (config.progress) {
    const file = cleanPath(config.progress.file);
    targets.push({ line: `/${file}`, probe: file });
  }
  return targets;
}

/** 行のうち、probe がまだ無視されていないものの行 */
async function missingLines(
  runner: Runner,
  root: string,
  targets: readonly IgnoreTarget[],
): Promise<string[]> {
  const lines: string[] = [];
  for (const target of targets) {
    if (target.probe.startsWith("../") || path.isAbsolute(target.probe))
      continue;
    const result = await runner(
      "git",
      ["check-ignore", "-q", "--no-index", "--", target.probe],
      { cwd: root, timeoutMs: ORCA_TIMEOUT_MS },
    );
    if (result.code === 0 || lines.includes(target.line)) continue;
    lines.push(target.line);
  }
  return lines;
}

/** タスクの記録の場所で、すでに git が追跡しているファイル（.gitignore の行を足しても追跡は続く） */
async function trackedRecordFiles(
  runner: Runner,
  root: string,
  config: {
    tasksDir: string;
    reportsDir: string;
    progress: { file: string } | null;
  },
): Promise<string[]> {
  const places = [config.tasksDir, config.reportsDir];
  if (config.progress) places.push(config.progress.file);
  const cleaned = places
    .map(cleanPath)
    .filter((p) => !p.startsWith("../") && !path.isAbsolute(p));
  if (cleaned.length === 0) return [];
  const result = await runner("git", ["ls-files", "--", ...cleaned], {
    cwd: root,
    timeoutMs: ORCA_TIMEOUT_MS,
  });
  if (result.code !== 0) return [];
  return [...new Set(result.stdout.split("\n").filter((l) => l !== ""))];
}

type FlowConfig = Awaited<ReturnType<typeof loadConfig>>["config"];

const SETTINGS_LOCAL = ".claude/settings.local.json";

/** exclude の行が、そのファイルを覆うか */
function covers(lines: readonly string[], file: string): boolean {
  return lines.some((line) =>
    line.endsWith("/") ? file.startsWith(line.slice(1)) : line === `/${file}`,
  );
}

/** config.json のキーを変えずに untracked だけ足した文 */
function withUntrackedKey(text: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return `${JSON.stringify({ ...parsed, untracked: true }, null, 2)}\n`;
}

async function readIfExists(file: string): Promise<string> {
  return existsSync(file) ? readFile(file, "utf8") : "";
}

/** `git ls-files` で追跡中のパスを、ステージだけ・push していないコミット・push 済みに分ける */
async function trackedFlowFiles(
  runner: Runner,
  root: string,
  extra: readonly string[],
): Promise<{ path: string; state: "staged" | "unpushed" | "pushed" }[]> {
  const listed = await runner(
    "git",
    ["ls-files", "-z", "--", ".orca-flow", SETTINGS_LOCAL, ...extra],
    { cwd: root, timeoutMs: ORCA_TIMEOUT_MS },
  );
  if (listed.code !== 0) return [];
  const found: { path: string; state: "staged" | "unpushed" | "pushed" }[] = [];
  for (const file of listed.stdout.split("\0").filter((l) => l !== "")) {
    const inHead = await runner("git", ["cat-file", "-e", `HEAD:${file}`], {
      cwd: root,
      timeoutMs: ORCA_TIMEOUT_MS,
    });
    if (inHead.code !== 0) {
      found.push({ path: file, state: "staged" });
      continue;
    }
    // リモートの側にそのファイルがあれば、手元で直してあっても push 済み
    const remote = await runner(
      "git",
      ["log", "--remotes", "-1", "--format=%H", "--", file],
      { cwd: root, timeoutMs: ORCA_TIMEOUT_MS },
    );
    found.push({
      path: file,
      state:
        remote.code === 0 && remote.stdout.trim() !== ""
          ? "pushed"
          : "unpushed",
    });
  }
  return found;
}

/** ステージ済み・push していないコミットで、そのファイルに足された行 */
async function addedLines(
  runner: Runner,
  root: string,
  file: string,
): Promise<Set<string>> {
  const added = new Set<string>();
  const sources = [
    ["diff", "--cached", "-U0", "--", file],
    ["log", "HEAD", "--not", "--remotes", "-p", "-U0", "--format=", "--", file],
  ];
  for (const args of sources) {
    const result = await runner("git", args, {
      cwd: root,
      timeoutMs: ORCA_TIMEOUT_MS,
    });
    if (result.code !== 0) continue;
    for (const line of result.stdout.split("\n"))
      if (line.startsWith("+") && !line.startsWith("+++"))
        added.add(line.slice(1).trim().replace(/\s+/g, " "));
  }
  return added;
}

async function runUntracked(
  ctx: CommandContext,
  root: string,
  config: FlowConfig,
  yes: boolean,
) {
  const detection = await detectRepo(root, ctx.runner);
  const files = await planFiles(root, detection, true);
  const configPath = path.join(root, CONFIG_PATH);
  const configText = await readIfExists(configPath);
  const untrackedKeyAdded = configText !== "" && !config.untracked;

  const stageSource = await readIfExists(
    path.join(root, ".orca-flow/setup.sh"),
  );
  const setupFile = files.find((f) => f.path === ".orca-flow/setup.sh");
  const setupStage: "present" | "missing" | "new" =
    setupFile?.action === "create"
      ? "new"
      : stageSource.includes(UNTRACKED_STAGE_HEADING)
        ? "present"
        : "missing";

  const common = await gitCommonDir(ctx.runner, root);
  const excludePath = path.join(common, "info/exclude");
  const attributesPath = path.join(common, "info/attributes");

  const wanted: IgnoreTarget[] = [
    { line: "/.orca-flow/", probe: ".orca-flow/orca-flow-probe" },
    ...recordTargets(config),
  ];
  if (config.decisionsFile) {
    const file = cleanPath(config.decisionsFile);
    wanted.push({ line: `/${file}`, probe: file });
  }
  wanted.push({ line: `/${SETTINGS_LOCAL}`, probe: SETTINGS_LOCAL });
  const candidates = new Set(wanted.map((t) => t.line));
  const unionCandidates = new Set(
    config.appendOnlyFiles.map((f) => `${f} merge=union`),
  );
  // ステージだけ・push していないコミットの追跡側の行は、消しても無視が続くよう exclude 側にも足す
  const trackedFlowLines: string[] = [];
  const forcedExclude: string[] = [];
  const forcedAttributes: string[] = [];
  for (const [file, set, forced] of [
    [".gitignore", candidates, forcedExclude],
    [".gitattributes", unionCandidates, forcedAttributes],
  ] as const) {
    const added = await addedLines(ctx.runner, root, file);
    for (const line of added)
      if (set.has(line)) {
        trackedFlowLines.push(`${file}：${line}`);
        forced.push(line);
      }
  }
  const exclude = await missingLines(ctx.runner, root, wanted);
  // exclude のファイルにすでにある行は重ねない（init を流し直すたびに増やさない）
  const excludePresent = (await readIfExists(excludePath))
    .split("\n")
    .map((line) => line.trim());
  for (const line of forcedExclude)
    if (!exclude.includes(line) && !excludePresent.includes(line))
      exclude.push(line);

  // 無視される（される予定の）ファイルは union の行がいらない
  const attributesText =
    (await readIfExists(path.join(root, ".gitattributes"))) +
    "\n" +
    (await readIfExists(attributesPath));
  const unionPresent = new Set(
    attributesText
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((words) => words.includes("merge=union"))
      .map((words) => words[0]),
  );
  const infoAttributes: string[] = [];
  for (const file of config.appendOnlyFiles) {
    if (unionPresent.has(file) || covers(exclude, cleanPath(file))) continue;
    const ignored = await missingLines(ctx.runner, root, [
      { line: file, probe: cleanPath(file) },
    ]);
    if (ignored.length === 0) continue;
    unionPresent.add(file);
    infoAttributes.push(`${file} merge=union`);
  }
  for (const line of forcedAttributes) {
    const file = line.replace(/ merge=union$/, "");
    const present = (await readIfExists(attributesPath)).split("\n");
    if (!infoAttributes.includes(line) && !present.includes(line))
      infoAttributes.push(line);
    unionPresent.add(file);
  }

  const orcaYamlText = await readIfExists(path.join(root, "orca.yaml"));
  const tracked = await trackedFlowFiles(ctx.runner, root, [
    ...(orcaYamlText.includes(".orca-flow/setup.sh") ? ["orca.yaml"] : []),
    ...(config.decisionsFile ? [cleanPath(config.decisionsFile)] : []),
  ]);
  const decisionsTracked =
    config.decisionsFile !== null &&
    tracked.some((t) => t.path === cleanPath(config.decisionsFile!));
  const trackedRecords = await trackedRecordFiles(ctx.runner, root, config);
  const untrackSteps = untrackSentences(
    tracked,
    trackedFlowLines,
    decisionsTracked,
  );

  let orca: OrcaResult = { registered: "skipped", visibility: "skipped" };
  let watch: WatchResult = { status: "skipped" };
  if (yes) {
    await mkdir(path.join(root, ".orca-flow"), { recursive: true });
    for (const file of files) {
      if (file.action !== "create" || file.content === undefined) continue;
      const full = path.join(root, file.path);
      await writeFile(full, file.content, { flag: "wx" });
      if (file.mode !== undefined) await chmod(full, file.mode);
    }
    if (untrackedKeyAdded)
      await writeFile(configPath, withUntrackedKey(configText));
    const append = async (file: string, lines: string[]) => {
      if (lines.length === 0) return;
      await mkdir(path.dirname(file), { recursive: true });
      const before = await readIfExists(file);
      const sep = before === "" || before.endsWith("\n") ? "" : "\n";
      await writeFile(file, `${before}${sep}${lines.join("\n")}\n`);
    };
    await append(excludePath, exclude);
    await append(attributesPath, infoAttributes);
    orca = await registerWithOrca(ctx.runner, root);
    if (config.taskEnd === "pr") {
      try {
        const done = await installWatchAutomation(ctx.runner, {
          root: await mainWorktreePath(ctx.runner, root),
          intervalMinutes: config.prWatch.intervalMinutes,
        });
        watch = { status: done.action };
      } catch (error) {
        watch = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  const hooks = await checkOrcaHooks(ctx.runner, root);

  const data: InitData = {
    yes,
    root,
    files: files.map(({ path: file, action }) => ({ path: file, action })),
    verify: detection.verify,
    pathVerify: detection.pathVerify,
    sharedPaths: detection.sharedPaths,
    readFirst: detection.readFirst,
    installLines: detection.installLines,
    gitattributes: [],
    gitignore: [],
    trackedRecords,
    orcaYamlToAdd: null,
    permissions: PERMISSIONS,
    askPermissions: ASK_PERMISSIONS,
    orca,
    watch,
    untracked: true,
    exclude,
    infoAttributes,
    trackedFlowFiles: tracked.map((t) => t.path),
    trackedFlowLines,
    untrackSteps,
    untrackedKeyAdded,
    setupStage,
    hooks,
  };
  if (!ctx.json) report(ctx, data, detection);
  return { code: 0 as const, data };
}

function untrackSentences(
  tracked: readonly { path: string; state: "staged" | "unpushed" | "pushed" }[],
  lines: readonly string[],
  decisionsTracked = false,
): string[] {
  const out: string[] = [];
  const by = (state: string) =>
    tracked.filter((t) => t.state === state).map((t) => t.path);
  const quote = (paths: string[]) =>
    paths.map((p) => `'${p.replaceAll("'", "'\\''")}'`).join(" ");
  if (by("staged").length > 0)
    out.push(
      `ステージだけのファイル：git rm -r --cached -- ${quote(by("staged"))} でインデックスから外してください（ファイルは残ります）`,
    );
  if (by("unpushed").length > 0)
    out.push(
      `push していないコミットにあるファイル：${by("unpushed").join("、")}。push する前に、そのコミットから外してください（直近のコミットなら git rm -r --cached -- ${quote(by("unpushed"))} のあと git commit --amend。前のコミットなら、git reset --soft でそのコミットの手前に戻してから、外してコミットし直します）`,
    );
  if (by("pushed").length > 0)
    out.push(
      `push 済みのファイル：${by("pushed").join("、")}。チームに出ているので、追跡をやめるコミット（git rm -r --cached -- ${quote(by("pushed"))}）をチームと相談して作ってください`,
    );
  if (decisionsTracked)
    out.push(
      "decisionsFile が追跡中です。追跡をやめないと、決定の記録は git に残さない形になりません（上の手順で外してください）",
    );
  if (lines.length > 0)
    out.push(
      `追跡側のファイルに足された行：${lines.join("、")}。untracked では .git/info/exclude と info/attributes に書くので、push する前に追跡側のファイルから消してください`,
    );
  if (out.length > 0)
    out.push("orca-flow は git の履歴とインデックスを書き換えません");
  return out;
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
    (item) =>
      typeof item.path === "string" &&
      real(fromWslUncPath(item.path)) === real(root),
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

function reportUntracked(lines: string[], data: InitData) {
  const verb = data.yes ? "足しました" : "足す";
  if (data.untrackedKeyAdded)
    lines.push(`  - ${CONFIG_PATH}：untracked のキーだけ${verb}`);
  if (data.setupStage === "missing")
    lines.push(
      `  - .orca-flow/setup.sh に「${UNTRACKED_STAGE_HEADING}」の段がありません。setup.sh を消して init --yes で作り直してください`,
    );
  else if (data.setupStage === "present")
    lines.push("  - .orca-flow/setup.sh：2b の段があります");
  lines.push(
    "  - .gitignore・.gitattributes・orca.yaml：untracked では触りません",
  );
  const exclude = data.exclude ?? [];
  if (exclude.length > 0) {
    lines.push(`  - .git/info/exclude：次の行を${verb}`);
    for (const line of exclude) lines.push(`      ${line}`);
  } else lines.push("  - .git/info/exclude：足す行はありません");
  const attrs = data.infoAttributes ?? [];
  if (attrs.length > 0) {
    lines.push(`  - .git/info/attributes：次の行を${verb}`);
    for (const line of attrs) lines.push(`      ${line}`);
  }
  if ((data.untrackSteps ?? []).length > 0) {
    lines.push(
      "",
      `すでに追跡されている orca-flow のファイル：${(data.trackedFlowFiles ?? []).join("、") || "なし"}`,
      ...(data.untrackSteps ?? []).map((l) => `  - ${l}`),
    );
  }
  if (data.trackedRecords.length > 0)
    lines.push(
      `  - 記録の場所に、チームが追跡中の同じ名前のファイルが${data.trackedRecords.length}件あります（exclude の行では外れません）`,
    );
  const hooks = data.hooks;
  lines.push(
    "",
    "Orca の画面の設定（毎回の確かめ）：",
    "  手順：Orca の設定画面でこのリポジトリの「ワークツリーフック」を開き、",
    `    ① 「セットアップスクリプト」に ${HOOK_SETUP_LINE} を入れる（空でなければ後ろの行に足す）`,
    "    ② 「セットアップが完了するまで待ってから Agent を開始」を入にする",
  );
  if (hooks?.ok === true) lines.push("  状態：そろっています");
  else if (hooks?.ok === false) {
    lines.push("  状態：そろっていません");
    for (const l of hooksFixLines(hooks)) lines.push(`    - ${l}`);
    lines.push(
      "  人が設定してから orca-flow init を流し直して確かめてください",
    );
  } else
    lines.push(
      `  状態：確かめられませんでした（${hooks?.message ?? "Orca に聞けません"}）。Orca を起動して orca-flow init を流し直してください`,
    );
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
  if (data.untracked) reportUntracked(lines, data);
  else {
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
    if (data.gitignore.length > 0) {
      lines.push(
        `  - .gitignore：次の行を${data.yes ? "足しました" : "足す"}（タスクの記録を公開に出さないため。足したくなければ --yes の前にこの一覧を見て、あとで行を消してください）`,
      );
      for (const line of data.gitignore) lines.push(`      ${line}`);
    } else {
      lines.push(
        "  - .gitignore：足す行はありません（タスクの記録の場所はすでに無視されています）",
      );
    }
    if (data.trackedRecords.length > 0) {
      lines.push(
        `  - すでに追跡中の記録が${data.trackedRecords.length}件あります。追跡中のファイルは .gitignore に行があっても公開に残ります。公開から外すには、作業中のタスクがないときに git rm -r --cached で追跡をやめるコミットを作ってください（12章）`,
      );
    }
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
    "人間と決めること：readFirst（先に読む文書。担当と確認役にも渡るので、種類ごとの決まりは入れず文書の側の表から指す）、progress（進捗表）、appendOnlyFiles（docs/decisions.md のような追記の表）、reviewerAgent、pathVerify、テンプレートに足す節",
  );
  const settingsFile = data.untracked
    ? ".claude/settings.local.json"
    : ".claude/settings.json";
  lines.push(
    "",
    `${settingsFile} の permissions.allow に足すとよい許可（orca-flow は書き換えません）：${data.permissions.join("、")}`,
    `${settingsFile} の permissions.ask に入れる許可（承認の門なので外さない。Bash(orca-flow *) の allow より先に効き、send と merge と qa deploy だけが許可の画面を出します）：${data.askPermissions.join("、")}`,
    `前から Bash(orca-flow *) を allow に入れている人は、allow はそのまま、permissions.ask に ${data.askPermissions.join(" と ")} を足してください。足したあと、/orca-flow:send の最初の実行で許可の画面が出ることを確かめます。出ないとき（権限を飛ばす形など）は、その形では send と merge と qa deploy を使いません`,
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
    if (data.watch.status === "created" || data.watch.status === "updated")
      lines.push(
        `  - 見張り（automation）：${data.watch.status === "created" ? "作りました" : "今の中身に直しました"}（5分おきなどの間隔は prWatch.intervalMinutes）。Orca の画面の「今すぐ実行」は押さないでください（確かめを飛ばして、worktree と会話が増えます）`,
      );
    else if (data.watch.status === "failed")
      lines.push(
        `  - 見張り（automation）：作れませんでした（${data.watch.message ?? ""}）。Orca を起動してから orca-flow pr-watch install を流してください`,
      );
    else
      lines.push(
        '  - 見張り（automation）：taskEnd が "pr" ではないので作りません。PR を出すタスクを見張るときは orca-flow pr-watch install を打ってください',
      );
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
