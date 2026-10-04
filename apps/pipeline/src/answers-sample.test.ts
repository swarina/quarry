import type { AnswerShape } from "@quarry/questions";
import type { OpenPosting } from "@quarry/storage/node";
import { describe, expect, it } from "vitest";
import { renderLabelGuide, renderLabelSheet, sampleAnswers } from "./answers-sample.ts";

const SHAPES: AnswerShape[] = [
  {
    id: "arrangement",
    version: 1,
    about: "Where the work is done",
    kind: "choice",
    options: ["remote", "hybrid", "onsite"],
    labels: ["Remote", "Hybrid", "On site"],
  },
  {
    id: "onCall",
    version: 1,
    about: "Whether the role is on call",
    kind: "noul",
    options: ["no", "yes"],
    labels: ["No", "Yes"],
  },
];

const choice = (probabilities: Record<string, number>) =>
  JSON.stringify({ type: "choice", choice: "remote", confidence: 0.5, probabilities });
const noul = (yes: number) => JSON.stringify({ type: "noul", noul: yes });

function posting(id: string, answers: Record<string, string> = {}): OpenPosting {
  return {
    id,
    company: `Company ${id}`,
    companyCountry: "US",
    firstSeenAt: 0,
    answers,
    posting: {
      externalId: id,
      title: `Engineer ${id}`,
      url: `https://example.com/${id}`,
      applyUrl: null,
      locations: [],
      places: [],
      country: null,
      workplace: null,
      employmentType: null,
      department: null,
      team: null,
      language: null,
      publishedAt: null,
      salary: null,
    },
  } as unknown as OpenPosting;
}

const answered = (id: string) =>
  posting(id, {
    "arrangement@1": choice({ remote: 0.7, hybrid: 0.2, onsite: 0.1 }),
    "onCall@1": noul(0.3),
  });

describe("sampling answered postings", () => {
  it("reads the stored answers into distributions, one per question", () => {
    const sample = sampleAnswers([answered("aaaa")], SHAPES, 10);
    expect(sample.predictions).toEqual([
      { posting: "aaaa", question: "arrangement", distribution: [70, 20, 10] },
      { posting: "aaaa", question: "onCall", distribution: [70, 30] },
    ]);
    expect(sample.rows).toEqual([
      {
        id: "aaaa",
        company: "Company aaaa",
        title: "Engineer aaaa",
        url: "https://example.com/aaaa",
      },
    ]);
  });

  it("takes only postings that hold every answer, so the sheet has no gaps", () => {
    const partial = posting("bbbb", {
      "arrangement@1": choice({ remote: 1, hybrid: 0, onsite: 0 }),
    });
    const sample = sampleAnswers([answered("aaaa"), partial, posting("cccc")], SHAPES, 10);
    expect(sample.rows.map((row) => row.id)).toEqual(["aaaa"]);
    expect(sample.considered).toBe(3);
    expect(sample.answered).toBe(1);
  });

  it("leaves out an answer stored under a wording that has since changed", () => {
    const stale = posting("bbbb", {
      "arrangement@9": choice({ remote: 1, hybrid: 0, onsite: 0 }),
      "onCall@1": noul(0.5),
    });
    expect(sampleAnswers([stale], SHAPES, 10).rows).toEqual([]);
  });

  it("leaves out an answer it cannot read", () => {
    const broken = posting("bbbb", {
      "arrangement@1": choice({ wfh: 1, hybrid: 0, onsite: 0 }),
      "onCall@1": noul(0.5),
    });
    expect(sampleAnswers([broken], SHAPES, 10).rows).toEqual([]);
  });

  it("stops at the size asked for", () => {
    const many = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].map(answered);
    expect(sampleAnswers(many, SHAPES, 3).rows).toHaveLength(3);
  });

  it("samples the same postings every time, so a re-run does not churn the sheet", () => {
    const many = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].map(answered);
    const first = sampleAnswers(many, SHAPES, 3).rows.map((row) => row.id);
    const again = sampleAnswers([...many].reverse(), SHAPES, 3).rows.map((row) => row.id);
    expect(again).toEqual(first);
  });

  it("does not simply take the postings in the order the store returns them", () => {
    const many = ["aaab", "aaac", "aaad", "aaae"].map(answered);
    // Ids differing only in their last character: in store order this would be the first two.
    const taken = sampleAnswers(many, SHAPES, 2).rows.map((row) => row.id);
    expect(taken).not.toEqual(["aaab", "aaac"]);
  });
});

describe("the labelling sheet", () => {
  const rows = [
    { id: "aaaa", company: "Acme", title: 'Engineer, "Platform"', url: "https://e.com/a" },
    { id: "bbbb", company: "Beta, Inc", title: "Designer", url: "https://e.com/b" },
  ];

  it("has a column per question, left empty for a person to fill", () => {
    const csv = renderLabelSheet(rows, SHAPES);
    const [header, first] = csv.trim().split("\n");
    expect(header).toBe('"id","company","title","url","arrangement","onCall","notes"');
    expect(first).toBe('"aaaa","Acme","Engineer, ""Platform""","https://e.com/a","","",""');
  });

  it("quotes a field holding a comma or a quote, so the file stays readable", () => {
    expect(renderLabelSheet(rows, SHAPES)).toContain('"Beta, Inc"');
    expect(renderLabelSheet(rows, SHAPES)).toContain('""Platform""');
  });

  it("does not put the model's answer in the sheet, which would anchor the labeller", () => {
    const csv = renderLabelSheet(rows, SHAPES);
    expect(csv).not.toContain("70");
    expect(csv).not.toContain("remote");
  });

  it("writes a header even when nothing was sampled", () => {
    expect(renderLabelSheet([], SHAPES).trim().split("\n")).toHaveLength(1);
  });
});

describe("the labelling guide", () => {
  it("lists every option a question allows, with what it means", () => {
    const guide = renderLabelGuide(SHAPES);
    for (const option of ["remote", "hybrid", "onsite", "no", "yes"]) {
      expect(guide).toContain(`\`${option}\``);
    }
    expect(guide).toContain("Where the work is done");
    expect(guide).toContain("Leave a cell empty");
  });

  it("uses no em dash, which the repository forbids", () => {
    expect(renderLabelGuide(SHAPES)).not.toContain(String.fromCodePoint(0x2014));
  });
});
