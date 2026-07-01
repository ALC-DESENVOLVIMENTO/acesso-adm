import { createApp } from "./app.js";

const port = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(port, () => {
  console.log(`Portal Administrativo API online na porta ${port}`);
});
