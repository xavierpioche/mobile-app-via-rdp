const crypto = require('crypto');

// Clé partagée avec le service qui émet les jetons utilisateur (votre backend d'identité).
const JWT_SECRET = process.env.AUTH_JWT_SECRET;
// Clé interne servant à signer les jetons de destruction de session (wipe).
const WIPE_SECRET = process.env.WIPE_SECRET;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'rdp-orchestrator';
const JWT_ISSUER = process.env.JWT_ISSUER || '';
// Durée de vie maximale acceptée pour un jeton (exp - iat), en secondes.
const MAX_TOKEN_TTL = Number(process.env.MAX_TOKEN_TTL_SECONDS) || 3600;
const CLOCK_SKEW = 30;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
	throw new Error('AUTH_JWT_SECRET manquant ou trop court (32 caractères minimum)');
}
if (!WIPE_SECRET || WIPE_SECRET.length < 32) {
	throw new Error('WIPE_SECRET manquant ou trop court (32 caractères minimum)');
}

class AuthError extends Error {}

const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlEncode = (buf) => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function safeEqual(a, b) {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Vérifie un JWT HS256 et renvoie ses claims. Lève AuthError si invalide.
function verifyJwt(token) {
	if (typeof token !== 'string' || token.length > 4096) throw new AuthError('jeton absent');
	const parts = token.split('.');
	if (parts.length !== 3) throw new AuthError('jeton mal formé');
	const [h, p, s] = parts;

	let header;
	let claims;
	try {
		header = JSON.parse(b64urlDecode(h).toString('utf8'));
		claims = JSON.parse(b64urlDecode(p).toString('utf8'));
	} catch {
		throw new AuthError('jeton illisible');
	}
	// Algorithme imposé : refuse "none" et toute substitution d'algorithme
	if (header.alg !== 'HS256') throw new AuthError('algorithme refusé');

	const expected = b64urlEncode(crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest());
	if (!safeEqual(s, expected)) throw new AuthError('signature invalide');

	const now = Math.floor(Date.now() / 1000);
	if (typeof claims.exp !== 'number') throw new AuthError('exp manquant');
	if (claims.exp + CLOCK_SKEW < now) throw new AuthError('jeton expiré');
	if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW > now) throw new AuthError('jeton pas encore valide');
	if (typeof claims.iat === 'number' && claims.exp - claims.iat > MAX_TOKEN_TTL) {
		throw new AuthError('durée de vie du jeton trop longue');
	}
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(JWT_AUDIENCE)) throw new AuthError('audience invalide');
	if (JWT_ISSUER && claims.iss !== JWT_ISSUER) throw new AuthError('émetteur invalide');
	if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('sub manquant');
	return claims;
}

// Middleware Express : exige "Authorization: Bearer <JWT>"
function requireUser(req, res, next) {
	const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
	try {
		req.user = verifyJwt(m ? m[1].trim() : undefined);
		req.userToken = m[1].trim();
		next();
	} catch (err) {
		if (!(err instanceof AuthError)) return next(err);
		console.warn(`[auth] refus ${req.method} ${req.path} : ${err.message}`);
		res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'non authentifié' });
	}
}

// Jeton de destruction lié à une session : HMAC(WIPE_SECRET, sessionId).
// Sans état : fonctionne quel que soit le réplica de l'orchestrateur qui reçoit l'appel.
function wipeTokenFor(sessionId) {
	return b64urlEncode(crypto.createHmac('sha256', WIPE_SECRET).update(`wipe:${sessionId}`).digest());
}

function checkWipeToken(sessionId, token) {
	return typeof token === 'string' && safeEqual(token, wipeTokenFor(sessionId));
}

// Identifiant d'utilisateur utilisable comme label Kubernetes (pas de données personnelles en clair)
function userLabel(sub) {
	return crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 32);
}

// Émet un JWT HS256 (utilisé uniquement par le lanceur de test /session/test-launch)
function signJwt(claims, ttlSeconds) {
	const now = Math.floor(Date.now() / 1000);
	const header = b64urlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
	const payload = b64urlEncode(Buffer.from(JSON.stringify({
		...claims,
		aud: JWT_AUDIENCE,
		...(JWT_ISSUER ? { iss: JWT_ISSUER } : {}),
		iat: now,
		exp: now + ttlSeconds,
		jti: crypto.randomBytes(8).toString('hex'),
	})));
	const sig = b64urlEncode(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
	return `${header}.${payload}.${sig}`;
}

module.exports = { requireUser, wipeTokenFor, checkWipeToken, userLabel, signJwt, safeEqual };
