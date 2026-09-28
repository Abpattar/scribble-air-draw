import { planCollection } from '../src/lib/mongodb.js';

export const FEATURE_CATALOG = [
  { key: 'templates', label: 'Trace template library' },
  { key: 'background_images', label: 'Import your own background image' },
  { key: 'export_transparent', label: 'Transparent PNG export' },
  { key: 'replay', label: 'Replay your drawing' },
  { key: 'record', label: 'Record & save your drawing' },
  { key: 'battles', label: 'Start group battles' },
];

export const FREE_FEATURES = {
  templates: false,
  background_images: false,
  export_transparent: false,
  replay: false,
  record: false,
  battles: true,
};

export const PRO_FEATURES = {
  templates: true,
  background_images: true,
  export_transparent: true,
  replay: true,
  record: true,
  battles: true,
};

export const DEFAULT_GALLERY_LIMIT = 3;
export const UNLIMITED = -1;

const SEEDS = [
  {
    id: 'free',
    label: 'Free',
    amount: 0,
    price: 0,
    period: 'monthly',
    interval: 1,
    totalCount: 1,
    features: { ...FREE_FEATURES },
    galleryLimit: DEFAULT_GALLERY_LIMIT,
    free: true,
    active: true,
    description: 'Start drawing for free',
  },
  {
    id: 'monthly',
    label: 'Monthly',
    amount: 99,
    price: 9900,
    period: 'monthly',
    interval: 1,
    totalCount: 12,
    features: { ...PRO_FEATURES },
    galleryLimit: UNLIMITED,
    free: false,
    active: true,
    description: 'Scribble Air Pro — one month',
  },
  {
    id: 'yearly',
    label: 'Yearly',
    amount: 999,
    price: 99900,
    period: 'yearly',
    interval: 1,
    totalCount: 1,
    features: { ...PRO_FEATURES },
    galleryLimit: UNLIMITED,
    free: false,
    active: true,
    description: 'Scribble Air Pro — one year',
  },
];

export async function ensurePlans() {
  try {
    const col = await withTimeout(planCollection(), 1500);
    if (!col) return;
    for (const seed of SEEDS) {
      await withTimeout(col.updateOne({ id: seed.id }, { $setOnInsert: seed }, { upsert: true }), 1500);
    }
  } catch {
    /* plans seeding must never break a request */
  }
}

// Loads plans straight from Mongo with a tight timeout. Returns `null` when
// the database is unreachable so callers can fall back to the seeded defaults.
export async function loadPlans() {
  try {
    const col = await withTimeout(planCollection(), 2000);
    if (!col) return null;
    await withTimeout(ensurePlans(), 2000).catch(() => {});
    const docs = await withTimeout(col.find({}).toArray(), 2000);
    if (!Array.isArray(docs) || !docs.length) return null;
    return docs;
  } catch {
    return null;
  }
}

// Client-friendly plan payload guaranteed to exist even with no database.
export function seedPlanPayload() {
  return {
    plans: SEEDS.filter((p) => !p.free && p.active).map(publicPlan),
    free: (SEEDS.find((p) => p.free) && publicPlan(SEEDS.find((p) => p.free))) || null,
    catalog: FEATURE_CATALOG,
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Database timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export async function entitlementFor(profile) {
  let byId = new Map();
  try {
    const p = await planCollection().then((col) => col.find({}).toArray());
    const plans = await withTimeout(p, 2000);
    byId = new Map((plans || []).map((pp) => [pp.id, pp]));
  } catch {
    /* fall through to defaults */
  }
  let chosen = null;
  if (profile && profile.plan && byId.has(profile.plan) && (profile.subscribedUntil || 0) > Date.now()) {
    chosen = byId.get(profile.plan);
  }
  const plan = chosen || byId.get('free') || { id: 'free', features: { ...FREE_FEATURES }, galleryLimit: DEFAULT_GALLERY_LIMIT };
  return {
    features: plan.features || { ...FREE_FEATURES },
    galleryLimit: plan.galleryLimit != null ? plan.galleryLimit : UNLIMITED,
    plan: plan.id || 'free',
    subscribed: !!chosen,
  };
}

export function publicPlan(plan) {
  return {
    id: plan.id,
    label: plan.label,
    amount: plan.amount,
    price: plan.price,
    period: plan.period,
    interval: plan.interval,
    totalCount: plan.totalCount,
    features: plan.features,
    galleryLimit: plan.galleryLimit,
    free: !!plan.free,
    active: !!plan.active,
    description: plan.description,
  };
}