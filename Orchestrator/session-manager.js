const express = require('express');
const cors = require('cors');
const k8s = require('@kubernetes/client-node');
const crypto = require('crypto');
const { createStatelessGuacSession } = require('./guac-json-auth');
const { requireUser, wipeTokenFor, checkWipeToken, userLabel } = require('./auth');

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
		// Le JWT déjà vérifié est transmis à l'application web finale (connexion automatique)
		const targetUrl = `https://tylshiloh.me/auth?token=${encodeURIComponent(req.userToken)}`;
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
		const guacamoleUrl = await createStatelessGuacSession({
			sessionId,
			podIP,
			rdpPassword,
			screenWidth,
			screenHeight,
		});
		console.log(`[session] ${sessionId} démarrée pour ${userId} (${screenWidth}x${screenHeight})`);
		res.json({ sessionId, guacamoleUrl, wipeToken: wipeTokenFor(sessionId) });
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