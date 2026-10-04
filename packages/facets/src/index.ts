export type { AnswerKind, Distribution } from "./answers.ts";
export {
  ANSWER_FACETS_VERSION,
  likeliest,
  probabilityOf,
  readAnswer,
} from "./answers.ts";
export { isPlaceholder } from "./placeholder.ts";
export type { AnnualPay, EmploymentType, FacetInput, StructuredFacets } from "./structured.ts";
export {
  annualPay,
  deriveFacets,
  EMPLOYMENT_TYPES,
  employmentTypes,
  STRUCTURED_FACETS_VERSION,
} from "./structured.ts";
