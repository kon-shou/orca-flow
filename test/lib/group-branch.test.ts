import { describe, expect, it } from "vitest";
import {
  chooseGroup,
  parseGroupTarget,
  splitTaskBranch,
  type ChildBranches,
} from "../../src/lib/group-branch.ts";
import { FlowError } from "../../src/types.ts";

const child = (
  name: string,
  branches: string[],
  branchPrefix = "task/",
): ChildBranches => ({ name, branchPrefix, idPrefix: "T", branches });

const retype = (branch: string) => `orca-flow qa plan ${branch}`;

const failure = (f: () => unknown): FlowError => {
  try {
    f();
  } catch (error) {
    if (error instanceof FlowError) return error;
    throw error;
  }
  throw new Error("止まりませんでした");
};

describe("parseGroupTarget", () => {
  it("ID の形なら ID（組の決めで止める）、そうでなければブランチ名", () => {
    expect(parseGroupTarget("T5")).toEqual({ kind: "id", id: "T5" });
    expect(parseGroupTarget("task/T5-member-order-limit")).toEqual({
      kind: "branch",
      branch: "task/T5-member-order-limit",
    });
  });

  it("使えるブランチ名でもなければ1", () => {
    expect(failure(() => parseGroupTarget("x y")).code).toBe(1);
    expect(failure(() => parseGroupTarget("../x")).code).toBe(1);
  });
});

describe("splitTaskBranch", () => {
  it("〈branchPrefix〉〈ID〉-〈短い名前〉 の形だけ読む", () => {
    expect(splitTaskBranch("task/T5-member-order-limit", "task/", "T")).toEqual(
      { id: "T5", slug: "member-order-limit" },
    );
    expect(splitTaskBranch("task/T5", "task/", "T")).toBeNull();
    expect(splitTaskBranch("task/T5-", "task/", "T")).toBeNull();
    expect(splitTaskBranch("feature/T5-x", "task/", "T")).toBeNull();
  });
});

describe("chooseGroup（ブランチ名）", () => {
  it("そのブランチのある子だけを組にし、番号だけ同じ子は組の外、ない子はなし", () => {
    const choice = chooseGroup(
      { kind: "branch", branch: "task/T5-member-order-limit" },
      [
        child("web", ["main", "task/T5-member-order-limit"]),
        child("admin", ["task/T5-member-export"]),
        child("api", ["main"]),
      ],
      retype,
    );
    expect(choice.id).toBe("T5");
    expect(choice.slug).toBe("member-order-limit");
    expect(Object.fromEntries(choice.members)).toEqual({
      web: { kind: "branch", branch: "task/T5-member-order-limit" },
      admin: { kind: "other", branches: ["task/T5-member-export"] },
      api: { kind: "none" },
    });
  });

  it("同じ ID の別のブランチも持つ子でも、そのブランチがあれば組", () => {
    const choice = chooseGroup(
      { kind: "branch", branch: "task/T5-member-order-limit" },
      [child("web", ["task/T5-member-export", "task/T5-member-order-limit"])],
      retype,
    );
    expect(choice.members.get("web")?.kind).toBe("branch");
  });

  it("branchPrefix の違う子は、短い名前が同じでもブランチ名が違うので組の外", () => {
    const choice = chooseGroup(
      { kind: "branch", branch: "task/T5-member-order-limit" },
      [
        child("web", ["task/T5-member-order-limit"]),
        child("api", ["feature/T5-member-order-limit"], "feature/"),
      ],
      retype,
    );
    expect(choice.members.get("api")?.kind).toBe("other");
  });

  it("allowMissing なら、どの子にもないブランチ名でも ID と短い名前を読み、子ごとの見分けを返す", () => {
    const choice = chooseGroup(
      { kind: "branch", branch: "task/T5-member-order-limit" },
      [child("web", ["main"]), child("admin", ["task/T5-member-export"])],
      retype,
      { allowMissing: true },
    );
    expect(choice.id).toBe("T5");
    expect(choice.slug).toBe("member-order-limit");
    expect(Object.fromEntries(choice.members)).toEqual({
      web: { kind: "none" },
      admin: { kind: "other", branches: ["task/T5-member-export"] },
    });
  });

  it("allowMissing でも、形が外れるブランチ名は1", () => {
    expect(
      failure(() =>
        chooseGroup(
          { kind: "branch", branch: "feature/order-limit" },
          [child("web", ["main"])],
          retype,
          { allowMissing: true },
        ),
      ).code,
    ).toBe(1);
  });

  it("形が外れる・どの子にもないブランチ名は1", () => {
    const children = [child("web", ["task/T5-member-order-limit"])];
    for (const branch of ["feature/order-limit", "task/T5", "task/T9-none"])
      expect(
        failure(() => chooseGroup({ kind: "branch", branch }, children, retype))
          .code,
      ).toBe(1);
  });
});

describe("chooseGroup（ID）", () => {
  const retypeLines = (message: string) =>
    message
      .split("\n")
      .filter((l) => l.includes("ブランチ名で打ち直してください（例"));
  const CAUTION =
    "組のブランチを消したあとなら、候補は番号だけ同じ別のタスクのものかもしれません。組のブランチ名で打ってください";

  it("短い名前がそろっていても、ID では組を決めずに1で候補とブランチ名で打ち直す1行を出す", () => {
    const error = failure(() =>
      chooseGroup(
        { kind: "id", id: "T5" },
        [
          child("web", ["task/T5-member-order-limit"]),
          child("api", ["task/T5-member-order-limit", "task/T6-other"]),
          child("admin", ["main"]),
        ],
        retype,
      ),
    );
    expect(error.code).toBe(1);
    const lines = error.message.split("\n");
    expect(lines).toContain("  web：task/T5-member-order-limit");
    expect(lines).toContain("  api：task/T5-member-order-limit");
    expect(error.message).not.toContain("admin：");
    expect(error.message).not.toContain("T6-other");
    expect(error.message).toContain("ブランチ名で打ってください");
    expect(retypeLines(error.message)).toEqual([
      "候補が組のブランチなら、ブランチ名で打ち直してください（例：orca-flow qa plan task/T5-member-order-limit）",
    ]);
    expect(lines).toContain(CAUTION);
  });

  it("allowMissing でも、ID では1", () => {
    expect(
      failure(() =>
        chooseGroup(
          { kind: "id", id: "T5" },
          [child("web", ["task/T5-member-order-limit"])],
          retype,
          { allowMissing: true },
        ),
      ).code,
    ).toBe(1);
  });

  it("どの子にも ID のブランチがなければ1で、ブランチ名で打つよう案内し、例の行を出さない", () => {
    const error = failure(() =>
      chooseGroup(
        { kind: "id", id: "T5" },
        [child("web", ["main"]), child("api", ["task/T50-other"])],
        retype,
      ),
    );
    expect(error.code).toBe(1);
    expect(error.message).toContain("ブランチ名");
    expect(error.message).toContain("〈branchPrefix〉〈ID〉-〈短い名前〉");
    expect(error.message).not.toContain("例：");
    expect(error.message).not.toContain("orca-flow qa plan");
  });

  it("短い名前が混ざれば1で、子ごとの候補とブランチ名で打ち直す1行を出す", () => {
    const error = failure(() =>
      chooseGroup(
        { kind: "id", id: "T5" },
        [
          child("web", ["main", "task/T5-member-order-limit"]),
          child("admin", ["task/T5-member-export"]),
          child("api", ["main"]),
        ],
        retype,
      ),
    );
    expect(error.code).toBe(1);
    const lines = error.message.split("\n");
    expect(lines).toContain("  web：task/T5-member-order-limit");
    expect(lines).toContain("  admin：task/T5-member-export");
    expect(error.message).not.toContain("api：");
    expect(retypeLines(error.message)).toEqual([
      "候補が組のブランチなら、ブランチ名で打ち直してください（例：orca-flow qa plan task/T5-member-order-limit）",
    ]);
    expect(lines).toContain(CAUTION);
  });

  it("全部の子に候補があれば、打ち直しの1行は条件をつけず、注意も出さない", () => {
    const error = failure(() =>
      chooseGroup(
        { kind: "id", id: "T5" },
        [
          child("web", ["task/T5-member-order-limit"]),
          child("admin", ["task/T5-member-order-limit"]),
        ],
        retype,
      ),
    );
    expect(error.code).toBe(1);
    expect(retypeLines(error.message)).toEqual([
      "ブランチ名で打ち直してください（例：orca-flow qa plan task/T5-member-order-limit）",
    ]);
    expect(error.message).not.toContain("候補が組のブランチなら");
    expect(error.message).not.toContain(CAUTION);
  });

  it("一部の子にだけ候補があれば、打ち直しの1行に条件をつけ、番号だけ同じ別のタスクかもしれない注意を添える", () => {
    const error = failure(() =>
      chooseGroup(
        { kind: "id", id: "T5" },
        [
          child("web", ["main"]),
          child("admin", ["main"]),
          child("api", ["main", "task/T5-member-export"]),
        ],
        retype,
      ),
    );
    expect(error.code).toBe(1);
    const lines = error.message.split("\n");
    expect(lines).toContain("  api：task/T5-member-export");
    expect(retypeLines(error.message)).toEqual([
      "候補が組のブランチなら、ブランチ名で打ち直してください（例：orca-flow qa plan task/T5-member-export）",
    ]);
    expect(lines).toContain(CAUTION);
  });

  it("一部の子にだけ候補があり使える形がなくても、注意を添える", () => {
    const error = failure(() =>
      chooseGroup(
        { kind: "id", id: "T5" },
        [child("web", ["main"]), child("api", ["task/T5-a;$(id)"])],
        retype,
      ),
    );
    expect(error.message).not.toContain("例：");
    expect(error.message.split("\n")).toContain(CAUTION);
  });

  it("打ち直しの例には使える形のブランチ名だけを使う", () => {
    const error = failure(() =>
      chooseGroup(
        { kind: "id", id: "T5" },
        [
          child("web", ["task/T5-a;$(id)"]),
          child("admin", ["task/T5-member-export"]),
        ],
        retype,
      ),
    );
    expect(error.code).toBe(1);
    const lines = error.message.split("\n");
    expect(lines).toContain("  web：task/T5-a;$(id)");
    expect(retypeLines(error.message)).toEqual([
      "ブランチ名で打ち直してください（例：orca-flow qa plan task/T5-member-export）",
    ]);
    expect(error.message).not.toContain("orca-flow qa plan task/T5-a;");
  });

  it("使える形の候補がなければ例の行を出さず、ブランチ名を変えるよう案内する", () => {
    const error = failure(() =>
      chooseGroup(
        { kind: "id", id: "T5" },
        [child("web", ["task/T5-a;$(id)"]), child("admin", ["task/T5-b c"])],
        retype,
      ),
    );
    expect(error.code).toBe(1);
    expect(error.message).not.toContain("例：");
    expect(error.message).not.toContain("orca-flow qa plan");
    expect(error.message).toContain("使える形のブランチ名に変えて");
  });

  it("branchPrefix の違う子も、その子の 〈branchPrefix〉〈ID〉- の候補を出す", () => {
    const error = failure(() =>
      chooseGroup(
        { kind: "id", id: "T5" },
        [
          child("web", ["task/T5-member-order-limit"]),
          child("api", ["feature/T5-member-order-limit"], "feature/"),
        ],
        retype,
      ),
    );
    expect(error.message.split("\n")).toContain(
      "  api：feature/T5-member-order-limit",
    );
  });
});
