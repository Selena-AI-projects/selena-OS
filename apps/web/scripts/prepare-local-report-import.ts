import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { prepareRetainedLocalReport } from "../src/server/selena-local-retained-report";

const [input, organizationId, projectId, output] = process.argv.slice(2);
if (!input || !organizationId || !projectId || !output || !input.endsWith(".json") || !output.endsWith(".json"))
	throw new Error(
		"Usage: prepare-local-report-import.ts report.json confirmed-organization-id confirmed-project-id import-packet.json",
	);
const bytes = await readFile(input);
const prepared = prepareRetainedLocalReport(JSON.parse(bytes.toString("utf8")), { organizationId, projectId });
await writeFile(
	output,
	JSON.stringify(
		{
			status: "PREPARED_NOT_IMPORTED",
			sourceReference: input,
			sourceHash: createHash("sha256").update(bytes).digest("hex"),
			organizationId,
			projectId,
			...prepared,
		},
		null,
		2,
	),
	{ flag: "wx" },
);
console.log("Prepared a validated local import packet. No database write or provider call was made.");
