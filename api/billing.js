import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { verifyToken } from '@clerk/backend';
import { requireUser } from '../src/lib/serverAuth.js';
import { planCollection, profileCollection } from '../src/lib/mongodb.js';
import { PERIOD_MS } from '../api-lib/plans.js';
import { ensurePlans } from '../api-lib/catalog.js';

// Consolidated Razorpay billing endpoint. On Vercel each rewrite below maps a
// legacy path to this handler with a ?route= query param:
//   /api/create-order         -> billing?route=create-order
//   /api/create-subscription  -> billing?route=create-subscription
//   /api/verify-payment       -> billing?route=verify-payment
//   /api/check-subscription   -> billing?route=check-subscription
//   /api/cancel-subscription  -> billing?route=cancel-subscription
//   /api/razorpay-webhook     -> billing?route=webhook
// The local dev server mounts the same paths and derives the route from the
// URL when no ?route= query is present.

function routeOf(request) {
  if (request.query?.route) return request.query.route;
  const p = (request.url || '').split('?')[0];
  if (p.endsWith('/create-subscription')) return 'create-subscription';
  if (p.endsWith('/verify-payment')) return 'verify-payment';
  if (p.endsWith('/check-subscription')) return 'check-subscription';
  if (p.endsWith('/cancel-subscription')) return 'cancel-subscription';
  if (p.endsWith('/razorpay-webhook')) return 'webhook';
  return 'create-order';
}

export default async function handler(request, response) {
  const route = routeOf(request);
  if (route === 'create-order') return createOrder(request, response);
  if (route === 'create-subscription') return createSubscription(request, response);
  if (route === 'verify-payment') return verifyPayment(request, response);
  if (route === 'check-subscription') return checkSubscription(request, response);
  if (route === 'cancel-subscription') return cancelSubscription(request, response);
  if (route === 'webhook') return webhook(request, response);
  return response.status(404).json({ error: 'Not found' });
}

async function createOrder(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const user = await requireUser(request);
  if (!user) {
    return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  }

  const keyId = process.env.RAZORPAY_KEY_ID || process.env.VITE_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return response.status(500).json({ error: 'Razorpay server configuration is missing.' });
  }

  await ensurePlans();
  const plan = await (await planCollection()).findOne({ id: request.body?.planId, active: true, free: { $ne: true } });
  if (!plan) {
    return response.status(400).json({ error: 'Unknown or disabled plan.' });
  }

  try {
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await razorpay.orders.create({
      amount: plan.price,
      currency: plan.currency || 'INR',
      receipt: `scribble-air-${user.userId.slice(0, 8)}-${Date.now()}`,
      notes: { app: 'scribble-air-draw', plan: plan.id },
    });

    await (await profileCollection()).updateOne(
      { _id: user.userId },
      { $set: { pendingPlan: plan.id, updatedAt: Date.now() } }
    );

    return response.status(200).json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId, plan: plan.id });
  } catch (error) {
    console.error('Razorpay order creation failed', error);
    return response.status(502).json({ error: 'Unable to create a Razorpay order.' });
  }
}

async function createSubscription(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const user = await requireUser(request);
  if (!user) {
    return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  }

  const keyId = process.env.RAZORPAY_KEY_ID || process.env.VITE_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return response.status(500).json({ error: 'Razorpay server configuration is missing.' });
  }

  await ensurePlans();
  const plan = await (await planCollection()).findOne({ id: request.body?.planId, active: true, free: { $ne: true } });
  if (!plan) {
    return response.status(400).json({ error: 'Unknown or disabled plan.' });
  }

  try {
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

    // Reuse an existing matching plan in Razorpay if one exists (idempotent),
    // otherwise create it. Plan ids are deterministic per amount+period in the
    // test environment, so duplicates are harmless.
    let razorpayPlan = null;
    try {
      const existing = await razorpay.plans.all({ count: 100 });
      for (const p of existing.items || []) {
        if (p.period === plan.period && p.item?.amount === plan.price) {
          razorpayPlan = p;
          break;
        }
      }
    } catch {
      razorpayPlan = null;
    }
    if (!razorpayPlan) {
      razorpayPlan = await razorpay.plans.create({
        period: plan.period,
        interval: plan.interval,
        item: {
          name: plan.label,
          amount: plan.price,
          currency: 'INR',
          description: plan.description,
        },
        notes: { app: 'scribble-air-draw', plan: plan.id },
      });
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: razorpayPlan.id,
      total_count: plan.totalCount,
      customer_notify: 1,
      notes: { app: 'scribble-air-draw', plan: plan.id },
    });

    await (await profileCollection()).updateOne(
      { _id: user.userId },
      {
        $set: {
          subscriptionId: subscription.id,
          pendingPlan: plan.id,
          updatedAt: Date.now(),
        },
      }
    );

    return response.status(200).json({
      keyId,
      subscriptionId: subscription.id,
      planId: razorpayPlan.id,
      plan: {
        id: plan.id,
        label: plan.label,
        amount: plan.amount,
      },
      customer: {
        email: user.profile?.email || '',
        name: user.profile?.nickname || 'Neon Air Drawer',
      },
    });
  } catch (error) {
    console.error('Razorpay subscription creation failed', error);
    const raw = String(error?.error?.description || error?.message || '');
    if (/authentication|key.?id|secret|unauthor/i.test(raw)) {
      return response.status(502).json({ error: 'Razorpay rejected the API keys. Check the key id/secret configured on Vercel.' });
    }
    if (/subscription|recurring|activated|plan/i.test(raw)) {
      return response.status(502).json({ error: 'Razorpay subscriptions are not enabled on this account yet. Enable Recurring Payments in the Razorpay Dashboard.' });
    }
    return response.status(502).json({ error: 'Unable to create a Razorpay subscription.' });
  }
}

async function verifyPayment(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    razorpay_subscription_id,
    idToken,
  } = request.body || {};

  if (!secret || !razorpay_payment_id || !razorpay_signature || !idToken) {
    return response.status(400).json({ error: 'Payment verification data is incomplete.' });
  }

  const isSubscription = Boolean(razorpay_subscription_id);
  if (!isSubscription && !razorpay_order_id) {
    return response.status(400).json({ error: 'Payment verification data is incomplete.' });
  }

  // 1. Verify the Razorpay signature. Subscriptions sign over
  //    `payment_id | subscription_id`; orders over `order_id | payment_id`.
  const signedPayload = isSubscription
    ? `${razorpay_payment_id}|${razorpay_subscription_id}`
    : `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const validSignature =
    expectedSignature.length === razorpay_signature.length &&
    crypto.timingSafeEqual(Buffer.from(expectedSignature, 'utf8'), Buffer.from(razorpay_signature, 'utf8'));
  if (!validSignature) {
    return response.status(400).json({ verified: false, error: 'Payment signature is invalid.' });
  }

  // 2. Verify the Clerk session token to get the REAL user id (can't be spoofed).
  const secretKey = process.env.CLERK_SECRET_KEY;
  let userId;
  try {
    const payload = await verifyToken(idToken, { secretKey });
    userId = payload.sub;
  } catch (error) {
    console.error('Clerk session verification failed:', error?.message || error);
    return response.status(401).json({ verified: false, error: 'Invalid session.' });
  }
  if (!userId) {
    return response.status(401).json({ verified: false, error: 'Invalid session.' });
  }

  // 3. Mark the account subscribed server-side.
  try {
    const col = await profileCollection();
    if (isSubscription) {
      const profile = await col.findOne({ _id: userId });
      await ensurePlans();
      const dbPlan = await (await planCollection()).findOne({ id: profile?.pendingPlan || 'monthly' }) || null;
      const periodKey = (dbPlan?.period && PERIOD_MS[dbPlan.period]) ? dbPlan.period : 'monthly';
      const subscribedUntil = Date.now() + PERIOD_MS[periodKey];
      const plan = {
        id: dbPlan?.id || 'monthly',
        label: dbPlan?.label || 'Monthly',
        price: dbPlan?.price || 9900,
        period: periodKey,
      };
      const payment = {
        paymentId: razorpay_payment_id,
        subscriptionId: razorpay_subscription_id,
        amount: plan.price,
        currency: 'INR',
        plan: plan.id,
        ts: Date.now(),
        status: 'charged',
      };
      await col.updateOne(
        { _id: userId },
        {
          $set: {
            subscribed: true,
            plan: plan.id,
            planPeriod: plan.period,
            subscribedUntil,
            subscriptionId: razorpay_subscription_id,
            pendingPlan: null,
            updatedAt: Date.now(),
          },
          $push: { payments: payment },
        },
        { upsert: true }
      );
    } else {
      const profile = await col.findOne({ _id: userId });
      await ensurePlans();
      const dbPlan = await (await planCollection()).findOne({ id: profile?.pendingPlan || 'monthly' }) || null;
      const periodKey = (dbPlan?.period && PERIOD_MS[dbPlan.period]) ? dbPlan.period : 'monthly';
      const plan = {
        id: dbPlan?.id || 'monthly',
        label: dbPlan?.label || 'Monthly',
        price: dbPlan?.price || 9900,
        period: periodKey,
      };
      await col.updateOne(
        { _id: userId },
        {
          $set: {
            subscribed: true,
            plan: plan.id,
            planPeriod: plan.period,
            subscribedUntil: Date.now() + PERIOD_MS[plan.period],
            pendingPlan: null,
            updatedAt: Date.now(),
          },
          $push: {
            payments: {
              paymentId: razorpay_payment_id,
              orderId: razorpay_order_id,
              amount: plan.price,
              currency: 'INR',
              plan: plan.id,
              ts: Date.now(),
              status: 'charged',
            },
          },
        },
        { upsert: true }
      );
    }
  } catch (error) {
    console.error('Failed to update subscription status:', error);
    return response.status(500).json({ verified: true, error: 'Payment verified but failed to update account.' });
  }

  return response.status(200).json({ verified: true });
}

async function checkSubscription(request, response) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const user = await requireUser(request);
  if (!user) {
    return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  }

  const profile = user.profile || {};
  await ensurePlans();
  const sub = profile.subscriptionId ? await (await planCollection()).findOne({ id: profile.plan }) : null;
  const periodKey = sub?.period && PERIOD_MS[sub.period] ? sub.period : 'monthly';
  let subscribed = !!profile.subscribed && (profile.subscribedUntil || 0) > Date.now();

  const subId = profile.subscriptionId;
  if (subId && !subscribed) {
    try {
      const keyId = process.env.RAZORPAY_KEY_ID || process.env.VITE_RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
      const razorSub = await razorpay.subscriptions.fetch(subId);
      if (razorSub && razorSub.status === 'active') {
        const subscribedUntil = Date.now() + PERIOD_MS[periodKey];
        subscribed = true;
        await (await profileCollection()).updateOne({ _id: user.userId }, { $set: { subscribed: true, subscribedUntil } });
      } else if (razorSub && (razorSub.status === 'cancelled' || razorSub.status === 'completed' || razorSub.status === 'expired')) {
        await (await profileCollection()).updateOne({ _id: user.userId }, { $set: { subscribed: false } });
      }
    } catch (error) {
      console.error('Failed to fetch Razorpay subscription:', error);
    }
  }

  return response.status(200).json({
    subscribed,
    plan: profile.plan || null,
    subscribedUntil: profile.subscribedUntil || null,
    subscriptionId: subId || null,
  });
}

async function cancelSubscription(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const user = await requireUser(request);
  if (!user) {
    return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  }

  const profile = user.profile || {};
  const subId = profile.subscriptionId;

  // Best-effort: if there's a real Razorpay subscription, ask Razorpay to end
  // it. Never fail the request if the Subscriptions API isn't enabled on the
  // account (one-time orders have nothing to cancel there) — cancellation is
  // finalised locally regardless.
  if (subId) {
    try {
      const keyId = process.env.RAZORPAY_KEY_ID || process.env.VITE_RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (keyId && keySecret) {
        await new Razorpay({ key_id: keyId, key_secret: keySecret }).subscriptions.cancel(subId, true);
      }
    } catch (error) {
      console.error('Razorpay subscription cancel failed (continuing):', error?.message || error);
    }
  }

  // One-time orders have no auto-renewal, so "cancel" ends the paid period
  // now at the user's request. Payment history stays for the record.
  await (await profileCollection()).updateOne(
    { _id: user.userId },
    {
      $set: {
        subscribed: false,
        subscribedUntil: 0,
        cancelledAt: Date.now(),
        updatedAt: Date.now(),
      },
    }
  );

  return response.status(200).json({ ok: true, message: 'Subscription cancelled.' });
}

async function webhook(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    return response.status(500).json({ error: 'Webhook secret is missing.' });
  }

  const raw = request.rawBody || (typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {}));
  const expected = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const received = request.headers?.['x-razorpay-signature'] || '';
  const valid =
    expected.length === received.length &&
    crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'));
  if (!valid) {
    return response.status(200).json({ ok: true }); // acknowledge + ignore invalid
  }

  try {
    const event = request.body?.event || '';
    const entity = request.body?.payload?.subscription?.entity || request.body?.payload?.payment?.entity || {};
    const subscriptionId = entity.subscription_id || entity.id || '';
    if (!subscriptionId) return response.status(200).json({ ok: true });

    // Covers both webhook v1 and v2 event names for Razorpay subscriptions.
    const chargedEvents = ['payment.captured', 'subscription.charged', 'payment.authorized'];
    const endedEvents = ['subscription.cancelled', 'subscription.completed', 'subscription.expired', 'subscription.paused', 'subscription.halted'];

    const col = await profileCollection();
    const profile = await col.findOne({ subscriptionId });

    if (chargedEvents.includes(event)) {
      const paymentId = entity.id || '';
      const payments = Array.isArray(profile?.payments) ? profile.payments : [];
      if (profile && !payments.some((p) => p.paymentId === paymentId)) {
        const current = profile.plan || 'monthly';
        const period = PERIOD_MS[profile.planPeriod] ? profile.planPeriod : PERIOD_MS[current] ? current : 'monthly';
        await col.updateOne(
          { _id: profile._id },
          {
            $set: { subscribed: true, subscribedUntil: Date.now() + PERIOD_MS[period], planPeriod: period, updatedAt: Date.now() },
            $push: {
              payments: {
                paymentId,
                subscriptionId,
                amount: entity.amount || 0,
                currency: entity.currency || 'INR',
                plan: current,
                ts: Date.now(),
                status: 'charged',
              },
            },
          }
        );
      }
    } else if (endedEvents.includes(event)) {
      if (profile) {
        const stillActive = (profile.subscribedUntil || 0) > Date.now() && entity.status === 'active';
        await col.updateOne({ _id: profile._id }, { $set: { subscribed: stillActive, updatedAt: Date.now() } });
      }
    }
    return response.status(200).json({ ok: true });
  } catch (error) {
    console.error('Razorpay webhook failed:', error);
    return response.status(500).json({ error: 'Webhook processing failed.' });
  }
}