import { requireUserId } from '../src/lib/serverAuth.js';
import { competitionCollection, profileCollection } from '../src/lib/mongodb.js';
import { idFilter } from '../api-lib/ids.js';
import { BattleError, castVote, cancelBattle, createBattle, endTurn, getBattle, listBattles, markReady, respond, submitEntry, syncStrokes } from '../api-lib/battleStore.js';

// HTTP adapter over ../api-lib/battleStore.js. It owns nothing but authentication,
// routing, the Mongo read wave and the status codes: the identity read always
// runs in the same wave as the battle read, so a whole handler is two round
// trips. Anything unexpected is a 503, never a 500; every refusal from the
// store carries its own 4xx.

function profileOf(userId) {
  return profileCollection().then((col) => col.findOne({ _id: userId }));
}

function byteLengthOf(request) {
  const n = Number(request?.headers?.['content-length']);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export default async function handler(request, response) {
  try {
    const userId = await requireUserId(request);
    if (!userId) return response.status(401).json({ error: 'Unauthorized: invalid session.' });

    const isDetail = request.query?.route === 'competition' || Boolean(request.query?.competitionId);
    if (isDetail) {
      if (request.method === 'GET') return detail(request, response, userId);
      if (request.method === 'POST') return act(request, response, userId);
      return response.status(405).json({ error: 'Method not allowed' });
    }

    if (request.method === 'GET') return list(request, response, userId);
    if (request.method === 'POST') return create(request, response, userId);
    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    if (error instanceof BattleError) return response.status(error.status).json({ error: error.message });
    console.error('competitions handler failed:', error?.message || error);
    return response.status(503).json({
      error: 'Battles are temporarily unavailable. Give it a moment and try again.',
    });
  }
}

// Wave 1: the caller (suspension check) and the battle itself.
function identity(userId, id) {
  return Promise.all([
    profileOf(userId),
    competitionCollection().then((col) => col.findOne(idFilter(id))),
  ]);
}

async function detail(request, response, userId) {
  const id = String(request.query?.competitionId || '');
  const [profile, doc] = await identity(userId, id);
  if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  if (!doc) return response.status(404).json({ error: 'Battle not found.' });

  // Metadata by default; pixel data only when the client asks for it, and only
  // when it actually needs it. This flag is a traffic decision, not an access
  // one: getBattle() decides who is allowed to see an in-progress drawing.
  const strokes = request.query?.strokes === '1' || request.query?.strokes === 'true';
  const view = await getBattle(userId, { id, doc, strokes });
  return response.status(200).json(view);
}

async function act(request, response, userId) {
  const id = String(request.query?.competitionId || '');
  const [profile, doc] = await identity(userId, id);
  if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  if (!doc) return response.status(404).json({ error: 'Battle not found.' });

  const body = request.body || {};
  const input = { id, doc, now: Date.now(), byteLength: byteLengthOf(request), strokes: body.strokes };
  const action = String(body.action || '');
  let result;
  if (action === 'respond') result = await respond(userId, { ...input, accept: body.decline ? false : body.accept !== false });
  else if (action === 'ready') result = await markReady(userId, input);
  else if (action === 'sync') result = await syncStrokes(userId, { ...input, from: body.from });
  else if (action === 'endTurn') result = await endTurn(userId, input);
  else if (action === 'submit') result = await submitEntry(userId, input);
  else if (action === 'vote') result = await castVote(userId, { ...input, side: body.side, groupId: body.groupId });
  else if (action === 'cancel') result = await cancelBattle(userId, input);
  else return response.status(400).json({ error: 'Unknown action.' });

  return response.status(200).json(result);
}

async function list(request, response, userId) {
  // Read-only, so the identity check rides along in the first wave.
  const [profile, result] = await Promise.all([profileOf(userId), listBattles(userId, {})]);
  if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  return response.status(200).json(result);
}

async function create(request, response, userId) {
  // The identity read has to land before anything is written.
  const profile = await profileOf(userId);
  if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  const result = await createBattle(userId, request.body || {});
  return response.status(200).json(result);
}
