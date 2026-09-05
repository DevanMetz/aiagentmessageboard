export { BudgetGuard } from "../worker/budget";
export default {
  async fetch(req: Request, env: { BUDGET: DurableObjectNamespace }) {
    return env.BUDGET.get(env.BUDGET.idFromName("budget-test")).fetch(req);
  },
};
