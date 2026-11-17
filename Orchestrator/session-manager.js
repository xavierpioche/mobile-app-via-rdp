const express = require('express');
const cors = require('cors');
const k8s = require('@kubernetes/client-node');
const crypto = require('crypto');
const { createTunnelToken } = require('./tunnel-token');
const path = require('path');
const { requireUser, wipeTokenFor, checkWipeToken, userLabel, signJwt, safeEqual } = require('./auth');

// Origines autorisées : WebView Capacitor (iOS = capacitor://localhost, Android = https://localhost)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
	'capacitor://localhost,https://localhost,http://localhost')
	.split(',')
	.map((o) => o.trim())
	.filter(Boolean);

const app = express();
app.use(cors({
	origin: ALLOWED_ORIGINS,
	methods: ['GET', 'POST', 'DELETE'],
	allowedHeaders: ['Content-Type', 'Authorization', 'X-Wipe-Token'],
}));
app.use(express.json({ limit: '8kb' }));
// navigator.sendBeacon() envoie du text/plain : le jeton de wipe peut arriver dans le corps
app.use(express.text({ limit: '1kb' }));

// Health check pour le load balancer GCE (Ingress) et la readinessProbe
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ---------------------------------------------------------------------------
// Lanceur de test : https://xmobile.tylshiloh.me/test/
// Sert le client web (mobile-rdp-app/www, copié dans l'image) et émet un JWT
// court contre un code de test. Désactivé si TEST_LAUNCH_CODE n'est pas défini.
// ---------------------------------------------------------------------------
const TEST_LAUNCH_CODE = process.env.TEST_LAUNCH_CODE || '';
const TEST_TOKEN_TTL = 300;
const LOGIN_RE = /^[\w.@-]{1,64}$/;

app.set('trust proxy', 1); // derrière le load balancer GCE : req.ip = IP du client
app.use('/test', express.static(path.join(__dirname, 'public'), {
	index: 'test.html',
	setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

// Anti force brute minimal (par réplica) : 5 échecs par IP et par tranche de 10 minutes
const launchFailures = new Map();
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
function tooManyFailures(ip) {
	const entry = launchFailures.get(ip);
	if (!entry || Date.now() - entry.since > FAIL_WINDOW_MS) {
		launchFailures.delete(ip);
		return false;
	}
	return entry.count >= MAX_FAILURES;
}
function recordFailure(ip) {
	const entry = launchFailures.get(ip);
	if (!entry || Date.now() - entry.since > FAIL_WINDOW_MS) launchFailures.set(ip, { count: 1, since: Date.now() });
	else entry.count += 1;
	if (launchFailures.size > 10000) launchFailures.clear();
}

// URL que Chromium doit ouvrir : http(s) uniquement (la NetworkPolicy bloque déjà les adresses privées)
function parseTargetUrl(raw) {
	if (typeof raw !== 'string' || raw.length > 2048) return null;
	try {
		const u = new URL(raw.trim());
		return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
	} catch {
		return null;
	}
}

app.post('/session/test-launch', (req, res) => {
	if (!TEST_LAUNCH_CODE) return res.status(404).json({ error: 'lanceur de test désactivé' });
	const ip = req.ip;
	if (tooManyFailures(ip)) return res.status(429).json({ error: 'trop d\'essais, réessayez plus tard' });

	const body = typeof req.body === 'object' && req.body ? req.body : {};
	if (typeof body.code !== 'string' || !safeEqual(body.code, TEST_LAUNCH_CODE)) {
		recordFailure(ip);
		console.warn(`[test-launch] code refusé (${ip})`);
		return res.status(403).json({ error: 'code de sécurité invalide' });
	}
	const login = typeof body.login === 'string' ? body.login.trim() : '';
	if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'login invalide (lettres, chiffres, . _ - @ ; 64 max)' });
	const url = body.url ? parseTargetUrl(body.url) : null;
	if (body.url && !url) return res.status(400).json({ error: 'URL invalide (http ou https)' });

	const token = signJwt({ sub: login, ...(url ? { app_url: url } : {}) }, TEST_TOKEN_TTL);
	console.log(`[test-launch] jeton émis pour ${userLabel(login)}`);
	res.json({ token, expiresIn: TEST_TOKEN_TTL });
});

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

const NAMESPACE = 'rdp-sessions';
const IMAGE_URI = process.env.KIOSK_IMAGE ||
	'africa-south1-docker.pkg.dev/lab-mobile-rdp-browser/rdp-browser-repo/kiosk-rdp:v4';

async function waitForPodIP(podName, timeoutMs = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const pod = await k8sApi.readNamespacedPod({ name: podName, namespace: NAMESPACE });
		if (pod.status?.phase === 'Running' && pod.status?.podIP) {
			return pod.status.podIP;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error('Timeout lors du démarrage du Pod MicroVM');
}

const SESSION_ID_RE = /^rdp-[0-9a-f]{12}$/;
const clampInt = (v, def, min, max) => {
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

async function deletePod(name) {
	await k8sApi.deleteNamespacedPod({ name, namespace: NAMESPACE, gracePeriodSeconds: 0 });
}

// Une seule session par utilisateur : les anciennes sont détruites au démarrage d'une nouvelle
async function wipeUserSessions(userId) {
	const list = await k8sApi.listNamespacedPod({
		namespace: NAMESPACE,
		labelSelector: `app=kiosk-rdp,user=${userId}`,
	});
	await Promise.all(list.items.map((p) => deletePod(p.metadata.name).catch(() => {})));
	return list.items.length;
}

app.post('/session/start', requireUser, async (req, res) => {
	const sessionId = `rdp-${crypto.randomBytes(6).toString('hex')}`;
	let podCreated = false;
	try {
		const body = typeof req.body === 'object' && req.body ? req.body : {};
		const screenWidth = clampInt(body.screenWidth, 390, 200, 2560);
		const screenHeight = clampInt(body.screenHeight, 844, 200, 2560);
		const userId = userLabel(req.user.sub);

		const replaced = await wipeUserSessions(userId);
		if (replaced) console.log(`[session] ${replaced} ancienne(s) session(s) détruite(s) pour ${userId}`);

		const rdpPassword = crypto.randomBytes(16).toString('hex');
		// URL choisie dans le lanceur de test (claim app_url), sinon l'application web
		// finale, à qui le JWT déjà vérifié est transmis (connexion automatique)
		const targetUrl = parseTargetUrl(req.user.app_url)
			|| `https://tylshiloh.me/auth?token=${encodeURIComponent(req.userToken)}`;
		const podManifest = {
			metadata: {
				name: sessionId,
				labels: { app: 'kiosk-rdp', session: sessionId, user: userId },
			},
			spec: {
				runtimeClassName: 'gvisor',
				restartPolicy: 'Never',
				activeDeadlineSeconds: 3600,
				automountServiceAccountToken: false,
				containers: [
					{
						name: 'xrdp-chromium',
						image: IMAGE_URI,
						ports: [{ containerPort: 3389 }],
						env: [
							{ name: 'APP_URL', value: targetUrl },
							{ name: 'RDP_PASSWORD', value: rdpPassword },
						],
						resources: {
							requests: { cpu: '500m', memory: '512Mi' },
							limits: { cpu: '1000m', memory: '1Gi' },
						},
						volumeMounts: [
							{ name: 'dshm', mountPath: '/dev/shm' },
							{ name: 'tmp-ram', mountPath: '/tmp' },
						],
					},
				],
				volumes: [
					{ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
					{ name: 'tmp-ram', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
				],
			},
		};
		await k8sApi.createNamespacedPod({ namespace: NAMESPACE, body: podManifest });
		podCreated = true;
		const podIP = await waitForPodIP(sessionId);
		await new Promise((r) => setTimeout(r, 1500));
		const tunnelToken = createTunnelToken({
			sessionId,
			podIP,
			rdpPassword,
			screenWidth,
			screenHeight,
		});
		console.log(`[session] ${sessionId} démarrée pour ${userId} (${screenWidth}x${screenHeight})`);
		res.json({ sessionId, tunnelToken, wipeToken: wipeTokenFor(sessionId) });
	} catch (err) {
		console.error(`[session] échec ${sessionId} : ${err.message}`);
		if (podCreated) await deletePod(sessionId).catch(() => {});
		res.status(500).json({ error: 'échec du démarrage de la session' });
	}
});

// Destruction : exige le jeton de wipe renvoyé par /session/start
// (en-tête X-Wipe-Token, ou corps texte/JSON pour navigator.sendBeacon)
async function wipeHandler(req, res) {
	const { sessionId } = req.params;
	if (!SESSION_ID_RE.test(sessionId)) return res.status(400).json({ error: 'identifiant invalide' });

	const token = req.get('x-wipe-token')
		|| (typeof req.body === 'string' ? req.body.trim() : req.body?.wipeToken);
	if (!checkWipeToken(sessionId, token)) {
		console.warn(`[wipe] refus pour ${sessionId}`);
		return res.status(403).json({ error: 'jeton de destruction invalide' });
	}
	try {
		const pod = await k8sApi.readNamespacedPod({ name: sessionId, namespace: NAMESPACE });
		// Ne jamais supprimer autre chose qu'un Pod de session kiosque
		if (pod.metadata?.labels?.app !== 'kiosk-rdp') return res.status(404).json({ error: 'session inconnue' });
		await deletePod(sessionId);
		console.log(`[wipe] ${sessionId} détruite`);
		res.json({ status: 'wiped' });
	} catch (err) {
		if (err.code === 404 || err.statusCode === 404 || /not ?found/i.test(err.message)) {
			return res.json({ status: 'already-gone' });
		}
		console.error(`[wipe] échec ${sessionId} : ${err.message}`);
		res.status(500).json({ error: 'échec de la destruction' });
	}
}
app.post('/session/:sessionId/wipe', wipeHandler);
app.delete('/session/:sessionId/wipe', wipeHandler);

app.listen(Number(process.env.PORT) || 3000,() => console.log('Orchestrateur RDP actif sur le port 3000'));