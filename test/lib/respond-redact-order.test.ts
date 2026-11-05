import { describe, expect, it } from "vitest";
import {
  LOG_LIMIT,
  renderRespondInput,
  type RespondSource,
} from "../../src/lib/respond-input.ts";

const token = (c: string) => `ghp_${c.repeat(36)}`;

const base = (): RespondSource => ({
  prNumber: 1,
  prUrl: "https://github.com/o/r/pull/1",
  viewer: "me",
  threads: [],
  threadsRead: 0,
  threadsTotal: 0,
  conversation: [],
  conversationTotal: 0,
  reviews: [],
  reviewsTotal: 0,
  ci: "passed",
  failedChecks: [],
});

const OFFSETS = [3990, 3995, 3999];
const bodyAt = (offset: number, t: string) =>
  "あ".repeat(offset) + t + "い".repeat(100);

function expectClean(text: string, c: string) {
  expect(text).not.toContain("ghp_");
  expect(text).not.toContain(c.repeat(4));
}

describe("respond の入力：伏せてから切る", () => {
  it("スレッドのコメント", () => {
    for (const offset of OFFSETS) {
      const s = base();
      s.threads = [
        {
          id: "T1",
          path: "a.ts",
          line: 1,
          outdated: false,
          moreComments: false,
          comments: [
            { author: "bob", mine: false, body: bodyAt(offset, token("A")) },
          ],
        },
      ];
      expectClean(renderRespondInput(s, "N1").text, "A");
    }
  });
  it("会話の欄", () => {
    for (const offset of OFFSETS) {
      const s = base();
      s.conversation = [
        {
          id: "C1",
          author: "bob",
          mine: false,
          body: bodyAt(offset, token("B")),
        },
      ];
      expectClean(renderRespondInput(s, "N1").text, "B");
    }
  });
  it("レビューの本文", () => {
    for (const offset of OFFSETS) {
      const s = base();
      s.reviews = [
        {
          id: "R1",
          state: "COMMENTED",
          author: "bob",
          body: bodyAt(offset, token("C")),
        },
      ];
      expectClean(renderRespondInput(s, "N1").text, "C");
    }
  });
  it("CI のログの末尾の境目", () => {
    for (const offset of [LOG_LIMIT - 10, LOG_LIMIT - 5, LOG_LIMIT - 1]) {
      const s = base();
      s.ci = "failed";
      s.failedChecks = [
        {
          name: "test",
          logTail: " ".repeat(offset) + token("D") + " ".repeat(100),
        },
      ];
      expectClean(renderRespondInput(s, "N1").text, "D");
    }
  });
});
