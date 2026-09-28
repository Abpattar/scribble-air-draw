import { loadPlans, seedPlanPayload, publicPlan } from '../api-lib/catalog.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method not allowed' });
  }
  try {
    // Best effort: returns the seeded default plans whenever Mongo is down so
    // the plans UI always has data to render.
    const fallback = seedPlanPayload();
    const docs = await loadPlans();
    if (!docs || !docs.length) {
      return response.status(200).json(fallback);
    }
    const active = docs.filter((p) => p.active);
    const free = active.find((p) => p.free) || fallback.free;
    const paid = active.filter((p) => !p.free);
    const plans = paid.length ? paid : fallback.plans;
    return response.status(200).json({
      plans: plans.map(publicPlan),
      free: free ? publicPlan(free) : null,
      catalog: fallback.catalog,
    });
  } catch (error) {
    // Last-resort: it should be impossible to get here, but never 500 a
    // read-only plans endpoint.
    return response.status(200).json(seedPlanPayload());
  }
}