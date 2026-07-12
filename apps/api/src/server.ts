import { createQuoteOpsApi, createQuoteOpsStore, startControlPlaneSyncScheduler } from "./index.js";

const port = Number(process.env.PORT || 8080);
// shared store: the sync scheduler must see the same workflow runs as the API
const store = createQuoteOpsStore();
const app = createQuoteOpsApi({ store });

app.listen(port, () => {
  console.log(`QuoteOps API listening on :${port}`);
});

startControlPlaneSyncScheduler({ store });
