import { describe, expect, it } from "vitest";
import type { AskReply, CriterionDescription } from "./criteria.ts";
import { answeredAmong, keep, merge, passes, readingOf } from "./held.ts";

const DESCRIPTION: CriterionDescription = {
  id: "c1",
  kind: "choice",
  options: ["never", "sometimes", "often"],
  labels: ["Never", "Sometimes", "Often"],
};

const REPORT: AskReply["report"] = {
  postings: 2,
  texts: 2,
  wanted: 2,
  cached: 0,
  asked: 2,
  failed: 0,
  costNanoUsd: 10,
  stoppedBy: "finished",
  outstanding: 0,
  errors: [],
};

function reply(
  answers: readonly { id: string; distribution: readonly number[] }[],
  description: CriterionDescription = DESCRIPTION,
): AskReply {
  return {
    criteria: [description],
    answers: answers.map((answer) => ({
      id: answer.id,
      answers: [{ criterionId: description.id, distribution: answer.distribution, cached: false }],
    })),
    report: REPORT,
  };
}

/** `keep` returns nothing for a reply describing no criterion, which these replies always do. */
function kept(reply: AskReply) {
  const held = keep(reply);
  if (held === undefined) throw new Error("the reply described no criterion");
  return held;
}

describe("keep", () => {
  it("reads the answers out of a reply", () => {
    const held = keep(reply([{ id: "a", distribution: [10, 30, 60] }]));
    expect(held?.criterionId).toBe("c1");
    expect(held?.byPosting.get("a")).toEqual([10, 30, 60]);
  });

  it("drops a distribution that does not fit the options", () => {
    // Joining a probability to an option by position only works while the widths agree. The
    // alternative to dropping it is labelling a number with whatever option sits at that index,
    // which would look like the model saying something it never said.
    const held = keep(reply([{ id: "a", distribution: [50, 50] }]));
    expect(held?.byPosting.has("a")).toBe(false);
  });

  it("keeps what arrived from a run that stopped early", () => {
    const partial = {
      ...reply([{ id: "a", distribution: [10, 30, 60] }]),
      report: { ...REPORT, stoppedBy: "budget" as const, outstanding: 1 },
    };
    // The stop reason governs what is said about the missing ones, not whether the ones that
    // arrived can be trusted.
    expect(keep(partial)?.byPosting.get("a")).toEqual([10, 30, 60]);
  });

  it("is nothing when the reply describes no criterion", () => {
    expect(keep({ criteria: [], answers: [], report: REPORT })).toBeUndefined();
  });
});

describe("merge", () => {
  it("adds newly answered postings to the ones already held", () => {
    const first = keep(reply([{ id: "a", distribution: [10, 30, 60] }]));
    const second = kept(reply([{ id: "b", distribution: [80, 10, 10] }]));
    const both = merge(first, second);
    expect([...both.byPosting.keys()].sort()).toEqual(["a", "b"]);
  });

  it("replaces everything when the criterion changed", () => {
    // A different wording is a different question (ADR-0024), so its answers are answers to
    // something else and must not be mixed in.
    const first = keep(reply([{ id: "a", distribution: [10, 30, 60] }]));
    const other = kept(
      reply([{ id: "b", distribution: [1, 1] }], {
        id: "c2",
        kind: "yes-no",
        options: ["no", "yes"],
        labels: ["No", "Yes"],
      }),
    );
    const merged = merge(first, other);
    expect(merged.criterionId).toBe("c2");
    expect(merged.byPosting.has("a")).toBe(false);
  });
});

describe("passes", () => {
  const held = kept(reply([{ id: "a", distribution: [10, 30, 60] }]));

  it("sums the probability across the chosen options", () => {
    expect(passes(held, "a", { options: ["sometimes", "often"], atLeast: 90 })).toBe(true);
    expect(passes(held, "a", { options: ["sometimes", "often"], atLeast: 91 })).toBe(false);
  });

  it("keeps an answer the model did not pick but thinks is plausible", () => {
    // This is the whole reason the distribution is stored rather than the picked option: 30% on
    // "sometimes" is a fact we hold, and filtering on the argmax would throw it away.
    expect(passes(held, "a", { options: ["sometimes"], atLeast: 25 })).toBe(true);
  });

  it("never passes a posting that was not answered, at any threshold", () => {
    // Not asked and certainly not are different facts, which is the position the index takes on
    // the standard questions too.
    expect(passes(held, "missing", { options: ["never"], atLeast: 1 })).toBe(false);
  });

  it("ignores options the criterion does not have", () => {
    expect(passes(held, "a", { options: ["nonsense"], atLeast: 1 })).toBe(false);
  });
});

describe("readingOf", () => {
  it("is the likeliest option and how probable it is", () => {
    const held = kept(reply([{ id: "a", distribution: [10, 30, 60] }]));
    expect(readingOf(held, "a")).toEqual({ label: "Often", probability: 60 });
  });

  it("is nothing for a posting with no answer", () => {
    const held = kept(reply([{ id: "a", distribution: [10, 30, 60] }]));
    expect(readingOf(held, "b")).toBeUndefined();
  });
});

describe("answeredAmong", () => {
  it("counts only the ones actually answered", () => {
    const held = kept(reply([{ id: "a", distribution: [10, 30, 60] }]));
    expect(answeredAmong(held, ["a", "b", "c"])).toBe(1);
  });
});
