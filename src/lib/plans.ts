// Client-side mirror of the server's plan seeds (api-lib/catalog.js) so the
// plans UI (in-app modal + homepage pricing) always has data to render even if
// /api/plans is unreachable. The server response replaces these when it loads.

export interface FeatureDef {
  key: string;
  label: string;
}

export interface PlanPlatform {
  id: string;
  label: string;
  amount: number;
  price: number;
  period: string;
  interval: number;
  totalCount: number;
  features: Record<string, boolean>;
  galleryLimit: number;
  free: boolean;
  active: boolean;
  description: string;
}

export const FEATURE_CATALOG: FeatureDef[] = [
  { key: 'templates', label: 'Trace template library' },
  { key: 'background_images', label: 'Import your own background image' },
  { key: 'export_transparent', label: 'Transparent PNG export' },
  { key: 'replay', label: 'Replay your drawing' },
  { key: 'record', label: 'Record & save your drawing' },
  { key: 'battles', label: 'Start group battles' },
];

export const DEFAULT_FREE_PLAN: PlanPlatform = {
  id: 'free',
  label: 'Free',
  amount: 0,
  price: 0,
  period: 'monthly',
  interval: 1,
  totalCount: 1,
  features: {
    templates: false,
    background_images: false,
    export_transparent: false,
    replay: false,
    record: false,
    battles: true,
  },
  galleryLimit: 3,
  free: true,
  active: true,
  description: 'Start drawing for free',
};

export const DEFAULT_PLANS: PlanPlatform[] = [
  {
    id: 'monthly',
    label: 'Monthly',
    amount: 99,
    price: 9900,
    period: 'monthly',
    interval: 1,
    totalCount: 12,
    features: {
      templates: true,
      background_images: true,
      export_transparent: true,
      replay: true,
      record: true,
      battles: true,
    },
    galleryLimit: -1,
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
    features: {
      templates: true,
      background_images: true,
      export_transparent: true,
      replay: true,
      record: true,
      battles: true,
    },
    galleryLimit: -1,
    free: false,
    active: true,
    description: 'Scribble Air Pro — one year',
  },
];

export const DEFAULT_PLAN_PAYLOAD = {
  plans: DEFAULT_PLANS,
  free: DEFAULT_FREE_PLAN,
  catalog: FEATURE_CATALOG,
};

export function galleryLabel(limit: number) {
  return limit === -1 ? 'Unlimited drawings' : `Up to ${limit} drawings`;
}

export function planPriceLabel(amount: number, period: string) {
  const per = (planId: string) => (planId === 'monthly' ? 'month' : 'year');
  return `₹${amount} / ${per(period)}`;
}