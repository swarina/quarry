import { choice, type EntryType, noul, type Questions, score } from "@quarry/jev";

/**
 * The standard questions asked of every posting (product 9). A question's wording *is* the
 * question: Jev reads it literally, so changing a word changes what the answers mean. Each
 * question therefore carries a version, answers are stored under it, and a wording change
 * means a new version and a fresh run rather than a silent shift in what we hold.
 *
 * Wordings follow the guidance in `notes/jev-notes.md`: ask exactly one thing, describe every
 * option concretely, say what an option is not when two are confusable, always leave an escape
 * hatch such as "not stated", and name the state field the answer comes from.
 */
export interface StandardQuestion {
  /** Stable across wordings; the version says which wording produced an answer. */
  readonly id: string;
  readonly version: number;
  /** What this answers, for the site and for a reader of the registry. */
  readonly about: string;
  /**
   * Whether a structured field from the board usually answers this already, in which case the
   * answer is a cross-check rather than the only source (product 9).
   */
  readonly alsoStructured: boolean;
  readonly question: Questions[string];
}

/** Everything the model is asked about one posting, by question id. */
export const STANDARD_QUESTIONS: readonly StandardQuestion[] = [
  {
    id: "arrangement",
    version: 1,
    about: "Whether the work is remote, hybrid, or on site",
    alsoStructured: true,
    question: choice(
      {
        question: "What work arrangement does `posting` offer?",
        focus: "Use what the posting states about where the work is done.",
      },
      {
        remote: {
          what: "The role can be done fully remotely, possibly limited to stated countries or time zones",
          not_for: "Roles that require regular office days",
        },
        hybrid: { what: "Regular office days are required, and some remote work is allowed" },
        onsite: {
          what: "The work happens at an office or other site, with no remote option stated",
        },
        not_stated: { what: "The posting does not say where the work is done" },
      },
    ),
  },
  {
    id: "seniority",
    version: 1,
    about: "How senior the role is, from intern to leadership",
    alsoStructured: false,
    question: score(
      {
        question: "What seniority level does `posting` hire for?",
        focus:
          "Judge from the responsibilities, scope, and experience asked for, not only the title.",
      },
      [
        { what: "Internship, apprenticeship, or working student" },
        { what: "Entry level: new graduates or early career, little experience expected" },
        { what: "Mid level: works independently on well-defined problems" },
        { what: "Senior: leads projects, mentors others, owns ambiguous problems" },
        {
          what: "Staff, principal, or leadership: sets direction across teams or manages managers",
        },
      ],
    ),
  },
  {
    id: "sponsorship",
    version: 1,
    about: "Whether visa sponsorship is offered, refused, or unmentioned",
    alsoStructured: false,
    question: choice(
      { question: "What does `posting` say about visa sponsorship for this role?" },
      {
        offers: { what: "States that visa sponsorship is available for this role" },
        does_not_offer: {
          what: "States that sponsorship is not available, or that candidates must already be authorized to work",
        },
        not_mentioned: { what: "Says nothing about visa sponsorship or work authorization" },
      },
    ),
  },
  {
    id: "onCall",
    version: 1,
    about: "Whether the role includes an on-call rota",
    alsoStructured: false,
    question: noul(
      "Does `posting` say the role includes on-call duty, a pager rota, or out-of-hours support?",
    ),
  },
];

/**
 * The questions as one request. Every question about a posting goes in a single request: the
 * posting's text is the expensive part and is shared, so each extra question costs a few tokens
 * (measured 2026-10-01, `notes/jev-notes.md` section 14). Postings are never packed together,
 * which that measurement showed changes the answers.
 */
export function standardQuestions(): Questions {
  return Object.fromEntries(STANDARD_QUESTIONS.map((entry) => [entry.id, entry.question]));
}

/**
 * A fingerprint of every wording asked for, so a run can tell which postings hold answers to
 * the questions as they are now and which were answered under an older wording.
 */
export function questionsVersion(): string {
  return STANDARD_QUESTIONS.map((entry) => `${entry.id}@${entry.version}`).join(",");
}

/** What a posting looks like to the model: the fields a question may name by path. */
export interface PostingFields {
  readonly title: string;
  readonly company: string;
  readonly locations: readonly string[];
  readonly description: string;
}

/**
 * The state one posting becomes. The full description is sent: trimming boilerplate saved 9% of
 * tokens and changed one answer in forty, because arrangement and sponsorship are often stated
 * exactly in the parts that look like boilerplate (`notes/jev-notes.md` section 14).
 */
export function postingState(posting: PostingFields): EntryType {
  return {
    posting: {
      title: posting.title,
      company: posting.company,
      locations: [...posting.locations],
      description: posting.description,
    },
  };
}
