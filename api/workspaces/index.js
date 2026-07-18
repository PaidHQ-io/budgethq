/**
 * DEPRECATED — workspace creation/listing now lives in paidhq-core, not here.
 *
 * BudgetHQ used to own its own `workspaces`/`workspace_members` tables and this endpoint. Once
 * the plan became "sell BudgetHQ, VaultHQ, ReportingHQ, AuditHQ under one PaidHQ account," that
 * responsibility moved to the shared paidhq-core service so every product shares one workspace/
 * membership/billing model instead of each growing its own. See db/schema.sql's header comment
 * and ../../../paidhq-core/README.md.
 *
 * The frontend should call paidhq-core's `/api/workspaces` (GET to list, POST to create) instead
 * of this route. Kept as a stub (rather than deleted) so a stray call fails loudly with a useful
 * message instead of a generic 404.
 */
import { withApi } from "../lib/http.js";

export default withApi(async (req, res) => {
  return res.status(410).json({
    error: "This endpoint has moved. Workspace creation/listing now lives in paidhq-core's /api/workspaces — see BudgetHQ's db/schema.sql for why.",
  });
});
