import { createControlPlaneApi } from "./index.js";

const port = Number(process.env.PORT ?? 19083);
const app = createControlPlaneApi();

app.listen(port, () => {
  console.log(`QuoteOps control plane API listening on ${port}`);
});
