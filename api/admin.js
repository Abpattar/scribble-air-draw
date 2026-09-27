import Razorpay from 'razorpay';
import { requireRole, requireUser } from '../src/lib/serverAuth.js';
import {
  competitionCollection,
  groupCollection,
  planCollection,
  profileCollection,
  requestsCollection,
} from '../src/lib/mongodb.js';
import { ensurePlans, publicPlan, PRO_FEATURES, FEATURE_CATALOG } from './lib/catalog.js';
import { safeObjectId } from './lib/ids.js';
import { phaseOf } from './lib/battle.js';
import { cancelBattlesForGroup } from './lib/battleStore.js';
import { CANCEL_REASON } from './lib/battle.js';

// Consolidated admin endpoint. On Vercel each rewrite in vercel.json maps a
// legacy path to this handler with a ?route= query param:
//   /api/admin                  -> admin?route=overview   (GET)
//   /api/admin/users            -> admin?route=users      (GET)
//   /api/admin/users/:userId    -> admin?route=user&userId=:userId  (GET/PATCH/DELETE)
//   /api/admin/billing          -> admin?route=billing    (GET/POST)
//   /api/admin/plans            -> admin?route=plans      (GET/POST)
//   /api/admin/plans/:planId    -> admin?route=plan&planId=:planId  (GET/PATCH/DELETE)
//   /api/admin/groups/:groupId  -> admin?route=group&groupId=:groupId  (DELETE)
//   /api/admin/competitions/:competitionId -> admin?route=competition&competitionId=:competitionId (DELETE)
// The local dev server mounts the same paths and derives the route from the
// URL + matched params when no ?route= query is present.

function routeOf(request) {
  const q = request.query || {};
  if (q.route) return q.route;
  if (q.userId) return 'user';
  if (q.groupId) return 'group';
  if (q.competitionId) return 'competition';
  if (q.planId) return 'plan';
  const p = (request.url || '').split('?')[0];
  if (p.includes('/users')) return 'users';
  if (p.includes('/plans')) return 'plans';
  if (p.includes('/billing')) return 'billing';
  if (p.includes('/groups')) return 'group';
  if (p.includes('/competitions')) return 'competition';
  return 'overview';
}

export default async function handler(request, response) {
  const route = routeOf(request);
  if (route === 'overview') return overview(request, response);
  if (route === 'users') return listUsers(request, response);
  if (route === 'user') return userAction(request, response);
  if (route === 'billing') return billingHandler(request, response);
  if (route === 'plans') return plansHandler(request, response);
  if (route === 'plan') return planAction(request, response);
  if (route === 'group') return deleteGroup(request, response);
  if (route === 'competition') return deleteCompetition(request, response);
  return response.status(404).json({ error: 'Not found' });
}

async function overview(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  const user = await requireRole(request, 'admin', 'superadmin');
  if (!user) return response.status(403).json({ error: 'Forbidden: admin access required.' });

  const profiles = await (await profileCollection()).find({}).toArray();
  const groups = await (await groupCollection()).find({}).sort({ createdAt: -1 }).limit(200).toArray();
  const competitions = await (await competitionCollection()).find({}).sort({ createdAt: -1 }).limit(200).toArray();

  let drawings = 0;
  let subscribers = 0;
  let revenue = 0;
  let payments = 0;
  const now = Date.now();
  for (const p of profiles) {
    drawings += Object.keys(p.drawings || {}).length;
    if (p.subscribed && (p.subscribedUntil || 0) > now) subscribers++;
    for (const pay of p.payments || []) {
      revenue += pay.amount || 0;
      payments++;
    }
  }

  const newUsers = profiles
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 8)
    .map((p) => ({
      id: p._id,
      nickname: p.nickname || '',
      email: p.email || '',
      createdAt: p.createdAt || 0,
    }));

  const recentCompetitions = competitions
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 6)
    .map((c) => ({
      id: String(c._id),
      prompt: c.prompt,
      status: phaseOf(c, now),
      createdAt: c.createdAt,
    }));

  const groupsList = groups.map((g) => ({
    id: String(g._id),
    name: g.name,
    emoji: g.emoji,
    adminId: g.adminId,
    memberCount: (g.memberIds || []).length,
    wins: g.wins || 0,
    played: g.played || 0,
    createdAt: g.createdAt || 0,
  }));

  const competitionsList = competitions.map((c) => ({
    id: String(c._id),
    prompt: c.prompt,
    groupA: c.groupA ? String(c.groupA) : null,
    groupB: c.groupB ? String(c.groupB) : null,
    status: phaseOf(c, now),
    createdAt: c.createdAt || 0,
    votes: Object.values(c.votes || {}).length,
  }));

  return response.status(200).json({
    users: profiles.length,
    drawings,
    groups: groupsList.length,
    competitions: competitionsList.length,
    competitionsPlayed: competitions.filter((c) => c.closedAt).length,
    subscribers,
    revenue,
    payments,
    newUsers,
    recentCompetitions,
    groupsList,
    competitionsList,
  });
}

async function listUsers(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  const user = await requireRole(request, 'admin', 'superadmin');
  if (!user) return response.status(403).json({ error: 'Forbidden: admin access required.' });

  const now = Date.now();
  const profiles = await (await profileCollection())
    .find({})
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();

  const rows = profiles.map((p) => ({
    id: p._id,
    nickname: p.nickname || '',
    email: p.email || '',
    avatar: p.avatar || '',
    role: p.role || 'user',
    subscribed: !!(p.subscribed && (p.subscribedUntil || 0) > now),
    subscribedUntil: p.subscribedUntil || null,
    plan: p.plan || null,
    suspended: !!p.suspended,
    createdAt: p.createdAt || 0,
    drawingCount: Object.keys(p.drawings || {}).length,
  }));

  return response.status(200).json({ users: rows });
}

async function userAction(request, response) {
  const actor = await requireRole(request, 'admin', 'superadmin');
  if (!actor) return response.status(403).json({ error: 'Forbidden: admin access required.' });

  const userId = String(request.query?.userId || '');
  if (!userId) return response.status(400).json({ error: 'Missing user id.' });
  const profile = await (await profileCollection()).findOne({ _id: userId });
  if (!profile) return response.status(404).json({ error: 'User not found.' });

  if (request.method === 'GET') {
    const { drawings, history, favorites, ...rest } = profile;
    return response.status(200).json({ profiles: [rest], drawings });
  }

  if (request.method === 'PATCH') {
    const body = request.body || {};
    const set = {};
    if (body.suspended !== undefined) set.suspended = !!body.suspended;
    if (body.role !== undefined) {
      // Role changes are superadmin-only.
      if (actor.role !== 'superadmin') return response.status(403).json({ error: 'Only superadmins can change roles.' });
      if (!['user', 'admin', 'superadmin'].includes(body.role)) return response.status(400).json({ error: 'Invalid role.' });
      set.role = body.role;
      if (body.role !== 'superadmin' && actor.userId === userId) {
        return response.status(400).json({ error: 'You cannot demote yourself.' });
      }
    }
    if (Object.keys(set).length) {
      await (await profileCollection()).updateOne({ _id: userId }, { $set: { ...set, updatedAt: Date.now() } });
    }
    return response.status(200).json({ ok: true });
  }

  if (request.method === 'DELETE') {
    await (await profileCollection()).updateOne(
      { _id: userId },
      { $set: { drawings: {}, history: {}, favorites: {}, updatedAt: Date.now() } }
    );
    return response.status(200).json({ ok: true, cleared: true });
  }

  return response.status(405).json({ error: 'Method not allowed' });
}

async function billingHandler(request, response) {
  if (request.method === 'GET') return getBilling(request, response);
  if (request.method === 'POST') return cancelBilling(request, response);
  return response.status(405).json({ error: 'Method not allowed' });
}

async function getBilling(request, response) {
  const user = await requireRole(request, 'admin', 'superadmin');
  if (!user) return response.status(403).json({ error: 'Forbidden: admin access required.' });

  const profiles = await (await profileCollection())
    .find({ $or: [{ subscribed: true }, { payments: { $exists: true, $ne: [] } }] })
    .sort({ updatedAt: -1 })
    .limit(300)
    .toArray();

  const now = Date.now();
  const rows = [];
  for (const p of profiles) {
    for (const pay of p.payments || []) {
      rows.push({
        id: pay.paymentId,
        userId: p._id,
        nickname: p.nickname || '',
        email: p.email || '',
        amount: pay.amount || 0,
        currency: pay.currency || 'INR',
        plan: pay.plan || null,
        ts: pay.ts || 0,
        status: pay.status || 'charged',
      });
    }
    if (p.subscriptionId && (p.subscribedUntil || 0) > now) {
      const active = rows.find((r) => r.userId === p._id && r.subscriptionId);
      if (!active) {
        rows.push({
          id: p.subscriptionId,
          userId: p._id,
          nickname: p.nickname || '',
          email: p.email || '',
          amount: 0,
          currency: 'INR',
          plan: p.plan || null,
          ts: p.subscribedUntil,
          status: 'active subscription',
        });
      }
    }
  }
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  return response.status(200).json({ payments: rows, total });
}

async function cancelBilling(request, response) {
  const user = await requireRole(request, 'superadmin');
  if (!user) return response.status(403).json({ error: 'Forbidden: superadmin access required.' });

  const userId = String(request.body?.userId || '');
  const profile = await (await profileCollection()).findOne({ _id: userId });
  if (!profile || !profile.subscriptionId) return response.status(400).json({ error: 'No active subscription for that user.' });

  try {
    const keyId = process.env.RAZORPAY_KEY_ID || process.env.VITE_RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    await razorpay.subscriptions.cancel(profile.subscriptionId, true);
    await (await profileCollection()).updateOne({ _id: userId }, { $set: { cancelledAt: Date.now(), updatedAt: Date.now() } });
    return response.status(200).json({ ok: true });
  } catch (error) {
    console.error('Failed to cancel subscription:', error);
    return response.status(502).json({ error: 'Unable to cancel that subscription.' });
  }
}

async function plansHandler(request, response) {
  const user = await requireUser(request);
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return response.status(403).json({ error: 'Forbidden: admin access required.' });
  }

  if (request.method === 'GET') {
    try {
      await ensurePlans();
      const plans = await (await planCollection()).find({}).sort({ price: 1 }).toArray();
      return response.status(200).json({ plans: plans.map(publicPlan), catalog: FEATURE_CATALOG });
    } catch (error) {
      return response.status(500).json({ error: error?.message || 'Could not load plans.' });
    }
  }

  if (request.method === 'POST') {
    if (user.role !== 'superadmin') {
      return response.status(403).json({ error: 'Forbidden: superadmin only.' });
    }
    const { label, amount, price, period, interval, totalCount, description } = request.body || {};
    if (!label || !label.trim()) {
      return response.status(400).json({ error: 'Plan label is required.' });
    }
    const id = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    if (!id) {
      return response.status(400).json({ error: 'Plan label must contain letters or numbers.' });
    }
    const fine = Math.round(Number(price) || Number(amount) * 100 || 0);
    if (!(fine > 0) || !['monthly', 'yearly'].includes(period || 'monthly')) {
      return response.status(400).json({ error: 'Plans need a positive price and a period (monthly/yearly).' });
    }
    try {
      const col = await planCollection();
      await ensurePlans();
      const existing = await col.findOne({ id });
      if (existing) {
        return response.status(409).json({ error: `A plan with id "${id}" already exists.` });
      }
      await col.insertOne({
        id,
        label: label.trim(),
        amount: Math.round(fine / 100),
        price: fine,
        period,
        interval: Number(interval) || 1,
        totalCount: Number(totalCount) || 1,
        features: { ...PRO_FEATURES },
        galleryLimit: -1,
        free: false,
        active: true,
        description: description || `${label.trim()} plan`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return response.status(201).json({ ok: true, plan: publicPlan({ id, label: label.trim(), amount: Math.round(fine / 100), price: fine, period, interval: Number(interval) || 1, totalCount: Number(totalCount) || 1, features: { ...PRO_FEATURES }, galleryLimit: -1, free: false, active: true, description: description || `${label.trim()} plan` }) });
    } catch (error) {
      return response.status(500).json({ error: error?.message || 'Could not create plan.' });
    }
  }

  return response.status(405).json({ error: 'Method not allowed' });
}

const PLAN_EDITABLE = ['label', 'period', 'interval', 'totalCount', 'features', 'galleryLimit', 'active', 'description'];

async function planAction(request, response) {
  const user = await requireUser(request);
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return response.status(403).json({ error: 'Forbidden: admin access required.' });
  }

  const planId = request.query?.planId || request.body?.planId;
  if (!planId) {
    return response.status(400).json({ error: 'Plan id is required.' });
  }

  try {
    await ensurePlans();
    const col = await planCollection();
    const plan = await col.findOne({ id: planId });
    if (!plan) {
      return response.status(404).json({ error: 'Plan not found.' });
    }

    if (request.method === 'GET') {
      return response.status(200).json({ plan: publicPlan(plan) });
    }

    if (request.method === 'PATCH') {
      if (user.role !== 'superadmin') {
        return response.status(403).json({ error: 'Forbidden: superadmin only.' });
      }
      const update = { updatedAt: Date.now() };
      const body = request.body || {};
      for (const field of PLAN_EDITABLE) {
        if (body[field] !== undefined) {
          if (field === 'features' && typeof body[field] === 'object') {
            const features = {};
            for (const key of Object.keys(plan.features || {})) {
              features[key] = body[field][key] === true || body[field][key] === false ? !!body[field][key] : !!plan.features[key];
            }
            update.features = features;
          } else if (field === 'label') {
            if (!body.label || !body.label.trim()) {
              return response.status(400).json({ error: 'Plan label is required.' });
            }
            update.label = body.label.trim();
          } else {
            update[field] = body[field];
          }
        }
      }
      if (body.amount !== undefined) {
        const amount = Number(body.amount);
        if (!(amount > 0)) {
          return response.status(400).json({ error: 'Paid plans need a positive price.' });
        }
        update.amount = amount;
        update.price = Math.round(amount * 100);
      } else if (body.price !== undefined) {
        const price = Number(body.price);
        if (!(price > 0)) {
          return response.status(400).json({ error: 'Paid plans need a positive price.' });
        }
        update.price = Math.round(price);
        update.amount = Math.round(price / 100);
      }
      await col.updateOne({ _id: plan._id }, { $set: update });
      const updated = await col.findOne({ _id: plan._id });
      return response.status(200).json({ ok: true, plan: publicPlan(updated) });
    }

    if (request.method === 'DELETE') {
      if (user.role !== 'superadmin') {
        return response.status(403).json({ error: 'Forbidden: superadmin only.' });
      }
      if (plan.free) {
        return response.status(400).json({ error: 'The free plan cannot be removed.' });
      }
      const activeHolders = await (await profileCollection()).countDocuments({ plan: planId, subscribedUntil: { $gt: Date.now() } });
      if (activeHolders > 0) {
        return response.status(409).json({ error: `Cannot remove: ${activeHolders} active subscriber${activeHolders === 1 ? '' : 's'} on this plan. Set it inactive instead.` });
      }
      await col.deleteOne({ _id: plan._id });
      return response.status(200).json({ ok: true });
    }

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return response.status(500).json({ error: error?.message || 'Could not update plan.' });
  }
}

async function deleteGroup(request, response) {
  if (request.method !== 'DELETE') return response.status(405).json({ error: 'Method not allowed' });
  const user = await requireRole(request, 'admin', 'superadmin');
  if (!user) return response.status(403).json({ error: 'Forbidden: admin access required.' });

  const id = String(request.query?.groupId || '');
  let group;
  try {
    group = await (await groupCollection()).findOne({ _id: safeObjectId(id) });
  } catch {
    group = null;
  }
  if (!group) return response.status(404).json({ error: 'Group not found.' });

  // Cancel the live battles and keep the documents, as leaving a group does.
  await cancelBattlesForGroup(String(group._id), { reason: CANCEL_REASON.GROUP_GONE });
  await (await requestsCollection()).deleteMany({ groupId: String(group._id) });
  await (await groupCollection()).deleteOne({ _id: group._id });
  return response.status(200).json({ ok: true, deleted: true });
}

async function deleteCompetition(request, response) {
  if (request.method !== 'DELETE') return response.status(405).json({ error: 'Method not allowed' });
  const user = await requireRole(request, 'admin', 'superadmin');
  if (!user) return response.status(403).json({ error: 'Forbidden: admin access required.' });

  const id = String(request.query?.competitionId || '');
  let comp;
  try {
    comp = await (await competitionCollection()).findOne({ _id: safeObjectId(id) });
  } catch {
    comp = null;
  }
  if (!comp) return response.status(404).json({ error: 'Competition not found.' });

  await (await competitionCollection()).deleteOne({ _id: comp._id });
  return response.status(200).json({ ok: true, deleted: true });
}