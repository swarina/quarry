import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { htmlToText, type NormalizedPosting } from "@quarry/domain";
import { openPipelineStore } from "@quarry/storage/node";
import { requireOption, writeOut } from "../cli.ts";

export const EXPORT_CRITERION_DATA_HELP = `  export-criterion-data    Write the posting text the deployed criterion path reads, as D1 SQL.
    --store <path>           Store to read postings from (required)
    --out <path>             SQL file to write (default: data/criterion-postings.sql)
`;

/**
 * Writes the posting text the Worker serves to D1, as a SQL file of INSERTs.
 *
 * The deployed criterion path reads descriptions from D1, because the browser cannot send them
 * and the search index deliberately carries none (ADR-0006, ADR-0029). This dumps exactly the
 * columns the D1 `PostingSource` reads, with the description already turned to plain text, so the
 * Worker does no HTML parsing. It emits a `DELETE` first, so reloading it replaces the set rather
 * than appending to it. Run `schema.sql` once before the first load to create the table.
 *
 * Load it with:  npx wrangler d1 execute quarry-criteria --remote --file=<out>
 */
export async function exportCriterionDataCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { store: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  const storePath = requireOption(values.store, "--store");
  const out = values.out ?? "data/criterion-postings.sql";

  const store = openPipelineStore(storePath);
  try {
    const rows = store.db
      .prepare(
        `SELECT p.id AS id, p.content_hash AS content_hash, b.company AS company,
                c.normalized_json AS normalized_json
           FROM postings p
           JOIN boards b ON b.id = p.board_id
           JOIN posting_contents c ON c.posting_id = p.id AND c.content_hash = p.content_hash
          WHERE b.status = 'active'
          ORDER BY p.id`,
      )
      .all() as {
      id: string;
      content_hash: string;
      company: string;
      normalized_json: string;
    }[];

    const lines = ["DELETE FROM criterion_postings;"];
    for (const row of rows) {
      const posting = JSON.parse(row.normalized_json) as NormalizedPosting;
      const values_ = [
        row.id,
        row.content_hash,
        posting.title,
        row.company,
        JSON.stringify(posting.locations),
        htmlToText(posting.descriptionHtml ?? ""),
      ];
      lines.push(
        `INSERT INTO criterion_postings (id, content_hash, title, company, locations_json, description) VALUES (${values_
          .map(quote)
          .join(", ")});`,
      );
    }

    await writeFile(out, `${lines.join("\n")}\n`);
    writeOut(`Wrote ${rows.length} postings to ${out}\n`);
    return 0;
  } finally {
    store.close();
  }
}

/** A SQL string literal: wrapped in single quotes, with any single quote inside doubled. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
